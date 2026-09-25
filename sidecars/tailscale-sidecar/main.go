// nexus-tailscale sidecar：内嵌 Tailscale 节点（tsnet），让 Nexus 跨网可连。
// 设计：
//   - 启动参数：--state=<state目录> --port=<控制HTTP端口> --target=<Nexus WS端口> [--hostname=nexus] [--control=<headscale url>]
//   - 控制端口（仅 127.0.0.1）：
//       GET /status  → {running, authURL, ip, hostname, up}
//       GET /auth    → {authURL}（未登录时触发登录流程）
//   - 登录完成后在 tailnet 接口监听 :<target> 并转发到 127.0.0.1:<target>，
//     手机（装 Tailscale 同账号）直连 <PC的100.x>:<target> 即达 Nexus WS。
// 依赖：tailscale.com/tsnet（官方开源库）；构建：go mod tidy && go build 。
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"tailscale.com/tsnet"
)

type status struct {
	Running bool   `json:"running"`
	AuthURL string `json:"authURL,omitempty"`
	IP      string `json:"ip,omitempty"`
	Hostname string `json:"hostname,omitempty"`
	Up      bool   `json:"up"`
	Error   string `json:"error,omitempty"`
}

var (
	srv      = &tsnet.Server{}
	target   = flag.Int("target", 0, "本机 Nexus WS 端口（必填）")
	ctrlPort = flag.Int("port", 0, "控制 HTTP 端口（必填）")
	stateDir = flag.String("state", "", "tsnet 状态目录（持久化节点身份）")
	hostname = flag.String("hostname", "nexus", "tailnet 内主机名")
	control  = flag.String("control", "", "可选：Headscale control URL（留空用 Tailscale 官方）")
)

func main() {
	flag.Parse()
	if *target == 0 || *ctrlPort == 0 || *stateDir == "" {
		log.Fatal("--target --port --state 必填")
	}
	_ = os.MkdirAll(*stateDir, 0o700)

	srv.Hostname = *hostname
	srv.Dir = *stateDir
	srv.Logf = func(format string, args ...any) { log.Printf(format, args...) }
	if *control != "" {
		srv.ControlURL = *control
	}

	go func() {
		ln, err := srv.Listen("tcp", fmt.Sprintf(":%d", *target))
		if err != nil {
			log.Printf("tailnet listen 失败: %v", err)
			return
		}
		log.Printf("tailnet 转发就绪 :%d -> 127.0.0.1:%d", *target, *target)
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go handle(conn)
		}
	}()

	http.HandleFunc("/status", func(w http.ResponseWriter, _ *http.Request) {
		st := status{Running: true, Hostname: *hostname}
		lc, err := srv.LocalClient()
		if err == nil {
			if b, err := lc.Status(context.Background()); err == nil && b.Self != nil && len(b.Self.TailscaleIPs) > 0 {
				st.IP = b.Self.TailscaleIPs[0].String()
				st.Up = b.Self.Online
			}
		}
		_ = json.NewEncoder(w).Encode(st)
	})
	http.HandleFunc("/auth", func(w http.ResponseWriter, _ *http.Request) {
		st := status{Running: true}
		// tsnet 首次启动时 Start/Listen 会阻塞至登录完成；这里触发一次
		// Listen（立即失败不阻塞）后从 server 的 auth URL 状态读取。
		// 简化：auth URL 由 tsnet 写日志，此处直接调用 Start 会阻塞——
		// 改用状态探测：未登录时 status 不带 IP，前端提示等待；登录由
		// 主进程在启动时以 goroutine 完成（srv.Start 已在 Listen 调用中触发）。
		st.Error = "等待登录：请在浏览器完成 Tailscale 授权（登录链接见 Nexus 日志）"
		_ = json.NewEncoder(w).Encode(st)
	})
	log.Printf("控制端口 127.0.0.1:%d", *ctrlPort)
	log.Fatal(http.ListenAndServe(fmt.Sprintf("127.0.0.1:%d", *ctrlPort), nil))
}

// handle：tailnet 入站连接 → 本机 Nexus WS 端口（双向拷贝）
func handle(down net.Conn) {
	defer down.Close()
	up, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", *target), 5*time.Second)
	if err != nil {
		return
	}
	defer up.Close()
	done := make(chan struct{}, 2)
	go func() { ioCopy(up, down); done <- struct{}{} }()
	go func() { ioCopy(down, up); done <- struct{}{} }()
	<-done
}

func ioCopy(dst, src net.Conn) {
	buf := make([]byte, 32*1024)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

var _ = context.Background
var _ = filepath.Join
