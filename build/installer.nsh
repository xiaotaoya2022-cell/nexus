; Nexus 自定义 NSIS 脚本（electron-builder nsis.include 挂载）
; 说明：electron-builder 模板（assistedInstaller.nsh）已内置路径补全——
;   allowToChangeInstallationDirectory 时在 InstFiles 前把 $INSTDIR 修正为
;   <所选目录>\Nexus（instFilesPre）。目录页上显示的原始路径只是预览，
;   本脚本仅在页面顶部向用户说明该行为，避免"会装进盘符根目录"的误解。

!macro customHeader
  ; MUI2 标准 define：目录页顶部文案（模板的 instFilesPre 负责实际补全）
  !define MUI_DIRECTORYPAGE_TEXT_TOP "Setup will create a 'Nexus' sub-folder inside the selected folder and install there (e.g. E:\Nexus). Click Install to continue."
!macroend
