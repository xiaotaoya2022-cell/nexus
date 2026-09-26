; Nexus custom NSIS script: directory autocomplete + page text.
;
; 双层路径补全：
; 1) electron-builder 模板内置 instFilesPre：点 Install 后把 $INSTDIR 修正为
;    <所选目录>\Nexus（assistedInstaller.nsh）。
; 2) .onVerifyInstDir（NSIS 全局回调，目录每次变化触发）：实时把 $INSTDIR
;    修正为 <所选目录>\Nexus——用户选 E:\ 时实际安装目录永远是 E:\Nexus。
; 升级安装（检测到已存在 Nexus.exe）不改动。

!macro customHeader
  DirText "Setup will create a Nexus sub-folder inside the selected folder and install there (e.g. E:\Nexus). To choose a different location, click Browse." "将安装到所选文件夹下的 Nexus 子文件夹（自动创建）。"
!macroend

Function .onVerifyInstDir
  Push $R0
  Push $R1

  ; 已有安装（可执行文件存在）→ 视为升级，不改动
  IfFileExists "$INSTDIR\Nexus.exe" nexusVerifyDone

  ; 末尾 6 字符已是 "\Nexus"（StrCmp 默认不区分大小写）→ 通过
  StrCpy $R0 $INSTDIR "" -6
  StrCmp $R0 "\Nexus" nexusVerifyDone

  ; 修正：去掉尾部反斜杠（如有）后追加 \Nexus
  StrCpy $R1 "$INSTDIR" "" -1
  StrCmp $R1 "\" 0 nexusAppend
  StrCpy $INSTDIR "$INSTDIR" -1
  nexusAppend:
  StrCpy $INSTDIR "$INSTDIR\Nexus"

  nexusVerifyDone:
  Pop $R1
  Pop $R0
FunctionEnd
