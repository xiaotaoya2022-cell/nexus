; Nexus custom NSIS script: directory-page text.
; Actual path completion is built-in (template instFilesPre rewrites $INSTDIR
; to <selected>\Nexus when Install is clicked).
!macro customHeader
  DirText "A Nexus sub-folder will be created automatically inside the selected folder (e.g. E:\Nexus). Click Install to continue." "Setup will create a Nexus sub-folder in the folder below and install there (e.g. E:\Nexus). To choose a different location, click Browse."
!macroend
