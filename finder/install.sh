#!/bin/zsh
# Installs the Finder Quick Action "Save Image to Inspiration Board" (right-click photos or
# folders → Quick Actions). Run again after editing save-to-inspiration-board.sh.
set -e
here=${0:A:h}
name="Save Image to Inspiration Board.workflow"
dest="$HOME/Library/Services/$name"

# Keep the previous version once (outside Services, so it doesn't show up twice in the menu)
backup="$HOME/.config/inspo-board/previous-quick-action.workflow"
if [[ -d $dest && ! -d $backup ]]; then
  mkdir -p "${backup:h}"
  cp -R "$dest" "$backup"
fi

rm -rf "$dest"
cp -R "$here/$name" "$dest"
plutil -replace actions.0.action.ActionParameters.COMMAND_STRING \
  -string "$(<"$here/save-to-inspiration-board.sh")" "$dest/Contents/document.wflow"
/System/Library/CoreServices/pbs -update
echo "Installed: right-click photos or folders in Finder → Quick Actions → Save Image to Inspiration Board"
