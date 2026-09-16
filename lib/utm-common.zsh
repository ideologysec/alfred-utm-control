#!/usr/bin/env zsh

: "${UTMCTL_BIN:=/Applications/UTM.app/Contents/MacOS/utmctl}"
: "${PLISTBUDDY_BIN:=/usr/libexec/PlistBuddy}"
: "${UTM_DOCS_DIR:=$HOME/Library/Containers/com.utmapp.UTM/Data/Documents}"
: "${UTM_ICON_DIR:=/Applications/UTM.app/Contents/Resources/Icons}"

json_string() {
  local value="${1:-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  print -r -- "\"$value\""
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

plist_get() {
  local plist_path="$1"
  local key_path="$2"

  [[ -f "$plist_path" ]] || return 0
  "$PLISTBUDDY_BIN" -c "Print $key_path" "$plist_path" 2>/dev/null || true
}

parse_utmctl_list_text() {
  emulate -L zsh
  setopt extendedglob

  local text
  local line uuid rest vm_status name
  local -a lines

  if (( $# > 0 )); then
    text="$1"
  else
    text="$(cat)"
  fi

  lines=("${(@f)text}")
  for line in "${lines[@]}"; do
    line="${line##[[:space:]]##}"
    line="${line%%[[:space:]]##}"
    [[ -z "$line" || "$line" == UUID[[:space:]]* ]] && continue

    uuid="${line%%[[:space:]]*}"
    rest="${line#$uuid}"
    rest="${rest##[[:space:]]##}"
    vm_status="${rest%%[[:space:]]*}"
    name="${rest#$vm_status}"
    name="${name##[[:space:]]##}"

    [[ -n "$uuid" && -n "$vm_status" && -n "$name" ]] || continue
    print -r -- "$uuid	$vm_status	$name"
  done
}

parse_utmctl_list_file() {
  local list_path="$1"
  [[ -f "$list_path" ]] || return 0
  parse_utmctl_list_text "$(<"$list_path")"
}

label_from_icon() {
  emulate -L zsh

  local icon="${1:-}"
  local lower="${icon:l}"
  local part word label=""
  local -a parts

  case "$lower" in
    ("") print -r -- ""; return ;;
    (mac|macos) print -r -- "macOS"; return ;;
    (ios) print -r -- "iOS"; return ;;
    (nixos) print -r -- "NixOS"; return ;;
    (windows*) print -r -- "Windows"; return ;;
  esac

  parts=("${(@s:-:)lower}")
  for part in "${parts[@]}"; do
    [[ -n "$part" ]] || continue
    word="${part[1]:u}${part[2,-1]}"
    if [[ -z "$label" ]]; then
      label="$word"
    else
      label="$label $word"
    fi
  done

  print -r -- "$label"
}

is_generic_icon() {
  local icon="${1:-}"
  case "${icon:l}" in
    (""|linux|bsd|unix|other) return 0 ;;
    (*) return 1 ;;
  esac
}

display_os_label() {
  local icon="${1:-}"
  local boot_os="${2:-}"
  local vm_name="${3:-}"
  local name_lower="${vm_name:l}"

  if ! is_generic_icon "$icon"; then
    label_from_icon "$icon"
    return
  fi

  if [[ -n "$boot_os" ]]; then
    print -r -- "$boot_os"
    return
  fi

  if [[ -n "$icon" ]]; then
    label_from_icon "$icon"
    return
  fi

  case "$name_lower" in
    (ubuntu|ubuntu[-_ ]*) print -r -- "Ubuntu" ;;
    (nixos|nixos[-_ ]*) print -r -- "NixOS" ;;
    (windows|windows[-_ ]*|win11|win11[-_ ]*|win10|win10[-_ ]*) print -r -- "Windows" ;;
    (macos|macos[-_ ]*) print -r -- "macOS" ;;
    (rocky|rocky[-_ ]*) print -r -- "Rocky Linux" ;;
    (linux|linux[-_ ]*) print -r -- "Linux" ;;
    (bsd|bsd[-_ ]*) print -r -- "BSD" ;;
    (*) print -r -- "" ;;
  esac
}

find_config_by_uuid() {
  local docs_dir="$1"
  local uuid="$2"
  local config config_uuid

  for config in "$docs_dir"/*.utm/config.plist(N); do
    config_uuid="$(plist_get "$config" ":Information:UUID")"
    if [[ "$config_uuid" == "$uuid" ]]; then
      print -r -- "$config"
      return
    fi
  done

  return 0
}

resolve_icon_path() {
  local icon_dir="$1"
  local icon="${2:-}"
  local icon_custom="${3:-false}"
  local icon_path

  [[ "$icon_custom" == true || -z "$icon" ]] && return 0

  icon_path="$icon_dir/$icon.png"
  [[ -f "$icon_path" ]] && print -r -- "$icon_path"
  return 0
}

filter_records() {
  local filter="${1:-all}"
  shift || true

  local record vm_status
  local -a startable_records
  for record in "$@"; do
    vm_status="${record#*$'\t'}"
    vm_status="${vm_status%%$'\t'*}"

    case "$filter" in
      (all) print -r -- "$record" ;;
      (running)
        [[ "$vm_status" == running || "$vm_status" == started ]] && print -r -- "$record"
        ;;
      (startable)
        [[ "$vm_status" == stopped || "$vm_status" == suspended || "$vm_status" == paused ]] && startable_records+=("$record")
        ;;
    esac
  done

  if [[ "$filter" == startable ]]; then
    (( ${#startable_records[@]} )) && printf '%s\n' "${startable_records[@]}" | LC_ALL=C sort
  fi

  return 0
}

human_memory_gb() {
  local memory_mb="${1:-}"
  [[ -n "$memory_mb" ]] || return 1
  [[ "$memory_mb" == <-> ]] || return 1
  if (( memory_mb < 1024 )); then
    print -r -- "$memory_mb MB"
  else
    printf '%.10g GB\n' "$((memory_mb / 1024.0))"
  fi
}

utm_cache_dir() {
  if [[ -n "${UTM_CACHE_DIR:-}" ]]; then
    print -r -- "$UTM_CACHE_DIR"
  elif [[ -n "${alfred_workflow_cache:-}" ]]; then
    print -r -- "$alfred_workflow_cache"
  else
    print -r -- "${TMPDIR:-/tmp}/alfred-utm-cache"
  fi
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
