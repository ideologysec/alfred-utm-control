#!/usr/bin/env zsh

: "${UTMCTL_BIN:=/Applications/UTM.app/Contents/MacOS/utmctl}"
: "${UTM_DOCS_DIR:=$HOME/Library/Containers/com.utmapp.UTM/Data/Documents}"
: "${UTM_ICON_DIR:=/Applications/UTM.app/Contents/Resources/Icons}"

is_start_action() {
  [[ "$1" == start || "$1" == start-disposable ]]
}

utm_now_ms() {
  zmodload zsh/datetime 2>/dev/null || true
  if [[ -n "${EPOCHREALTIME:-}" ]]; then
    printf '%.0f\n' "$(( EPOCHREALTIME * 1000 ))"
  else
    print -r -- "$(($(date +%s) * 1000))"
  fi
}

utm_debug_log() {
  [[ "${UTM_DEBUG:-0}" == 1 ]] || return 0
  print -ru2 -- "[alfred-utm] $*"
}

# Call directly (not in a subshell) to retain the output and error variables.
utm_command() {
  emulate -L zsh

  UTM_COMMAND_OUTPUT=""
  UTM_COMMAND_ERROR=""
  local stderr_file stderr_text
  local cmd_status=0

  if ! stderr_file="$(mktemp "${TMPDIR:-/tmp}/alfred-utm-command.XXXXXX")"; then
    UTM_COMMAND_ERROR="Could not capture UTM command diagnostics."
    return 1
  fi

  {
    if UTM_COMMAND_OUTPUT="$("$@" 2>"$stderr_file")"; then
      cmd_status=0
    else
      cmd_status=$?
    fi
    stderr_text="$(<"$stderr_file")"
    # Keep warnings in Alfred's debugger, never in list or IP-address data.
    /bin/cat "$stderr_file" >&2
  } always {
    /bin/rm -f "$stderr_file"
  }

  if (( cmd_status == 0 )) && [[ "$stderr_text" == 'Error from event:'* || "$stderr_text" == *$'\nError from event:'* ]]; then
    cmd_status=1
  fi
  if (( cmd_status != 0 )); then
    UTM_COMMAND_ERROR="${stderr_text:-${UTM_COMMAND_OUTPUT:-UTM command failed (exit status $cmd_status).}}"
  fi
  return "$cmd_status"
}


utm_metadata_signature() {
  emulate -L zsh
  setopt null_glob pipe_fail

  local -a configs=("$UTM_DOCS_DIR"/*.utm/config.plist)
  {
    print -r -- "metadata-schema=1"
    print -r -- "docs=$UTM_DOCS_DIR"
    # Hash contents as well as paths: same-size edits within one second count.
    if (( ${#configs[@]} )); then
      /usr/bin/cksum "${configs[@]}" || return 1
    fi
  } | /usr/bin/cksum
}
