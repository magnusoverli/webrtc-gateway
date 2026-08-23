#!/usr/bin/env bash

set -uo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:8080}"
SRT_HOST="${SRT_HOST:-127.0.0.1}"
PUSH_PORT="${PUSH_PORT:-11991}"
ISOLATION_PORT="${ISOLATION_PORT:-11992}"
PULL_PORT="${PULL_PORT:-12010}"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-30}"
VIEWERS="${VIEWERS:-4}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PULL_PASSPHRASE="resilience-passphrase"

for executable in curl jq ffmpeg node docker; do
  if ! command -v "$executable" >/dev/null; then
    printf 'missing required executable: %s\n' "$executable" >&2
    exit 2
  fi
done

if ! curl --fail --silent --show-error "$GATEWAY_URL/healthz" >/dev/null; then
  printf 'gateway is not healthy at %s\n' "$GATEWAY_URL" >&2
  exit 2
fi

work_dir="$(mktemp -d)"
declare -a channel_ids=()
declare -a source_pids=()
passes=0
failures=0
created_id=""
created_path=""
last_pid=""

stop_source() {
  local pid="$1"
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" 2>/dev/null || true
    return
  fi
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || true
      return
    fi
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  local pid
  local id
  for pid in "${source_pids[@]}"; do
    stop_source "$pid"
  done
  for id in "${channel_ids[@]}"; do
    curl --silent --output /dev/null --request DELETE "$GATEWAY_URL/api/v1/channels/$id" || true
  done
  rm -rf -- "$work_dir"
}
trap cleanup EXIT INT TERM

pass() {
  passes=$((passes + 1))
  printf '%-32s PASS  %s\n' "$1" "$2"
}

fail() {
  failures=$((failures + 1))
  printf '%-32s FAIL  %s\n' "$1" "$2" >&2
}

create_push_channel() {
  local name="$1"
  local port="$2"
  local response
  response="$(jq -n --arg name "$name" --argjson port "$port" '{
    name:$name,
    enabled:true,
    automaticPreview:false,
    input:{mode:"srt-push",srt:{port:$port}},
    maxReaders:0,
    useAbsoluteTimestamp:true
  }' | curl --fail --silent --show-error --header 'Content-Type: application/json' --data-binary @- \
    "$GATEWAY_URL/api/v1/channels")" || return 1
  created_id="$(jq -r '.id' <<<"$response")"
  created_path="$(jq -r '.path' <<<"$response")"
  channel_ids+=("$created_id")
}

create_pull_channel() {
  local response
  response="$(jq -n --argjson port "$PULL_PORT" --arg passphrase "$PULL_PASSPHRASE" '{
    name:"SRT pull resilience temporary",
    enabled:true,
    automaticPreview:false,
    input:{mode:"srt-pull",srt:{host:"127.0.0.1",port:$port,passphrase:$passphrase}},
    maxReaders:0,
    useAbsoluteTimestamp:true
  }' | curl --fail --silent --show-error --header 'Content-Type: application/json' --data-binary @- \
    "$GATEWAY_URL/api/v1/channels")" || return 1
  created_id="$(jq -r '.id' <<<"$response")"
  created_path="$(jq -r '.path' <<<"$response")"
  channel_ids+=("$created_id")
}

channel_status() {
  local id="$1"
  curl --fail --silent --show-error "$GATEWAY_URL/api/v1/status" |
    jq -c --arg id "$id" '.channels[] | select(.id == $id)'
}

wait_ready() {
  local id="$1"
  local mode="$2"
  local state
  local attempts=$((READY_TIMEOUT_SECONDS * 4))
  for _ in $(seq 1 "$attempts"); do
    state="$(channel_status "$id" 2>/dev/null || true)"
    if [[ -n "$state" ]] && jq -e --arg mode "$mode" \
      '.outputReady and .compatibility.state == "ready" and .compatibility.mode == $mode' \
      <<<"$state" >/dev/null; then
      printf '%s' "$state"
      return 0
    fi
    sleep 0.25
  done
  return 1
}

wait_offline() {
  local id="$1"
  local state
  for _ in $(seq 1 120); do
    state="$(channel_status "$id" 2>/dev/null || true)"
    if [[ -n "$state" ]] && jq -e \
      '(.available | not) and (.outputReady | not) and (.compatibility.worker.running | not)' \
      <<<"$state" >/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

start_source() {
  local name="$1"
  local format="$2"
  local target="$3"
  local -a codecs
  case "$format" in
    direct)
      codecs=(-c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline -pix_fmt yuv420p -bf 0 -g 30 -c:a libopus -application lowdelay -b:a 96k)
      ;;
    normalized)
      codecs=(-c:v libx265 -preset ultrafast -x265-params pools=1:frame-threads=1:keyint=30:bframes=0 -c:a aac -b:a 128k -ac 2)
      ;;
    *)
      printf 'unknown source format: %s\n' "$format" >&2
      return 2
      ;;
  esac

  ffmpeg -hide_banner -loglevel error -nostdin \
    -re -f lavfi -i testsrc2=size=640x360:rate=30 \
    -re -f lavfi -i sine=frequency=1000:sample_rate=48000 \
    -map 0:v:0 -map 1:a:0 "${codecs[@]}" -f mpegts "$target" \
    >"$work_dir/$name.log" 2>&1 &
  last_pid=$!
  source_pids+=("$last_pid")
}

probe_channel() {
  local id="$1"
  node "$SCRIPT_DIR/whep-probe.mjs" "$GATEWAY_URL/api/v1/channels/$id/whep"
}

find_worker_pid() {
  local id="$1"
  local container
  local pid
  local args
  local marker="compat-${id//-/}"
  container="$(docker compose ps -q gateway)"
  [[ -n "$container" ]] || return 1
  while read -r pid args; do
    if [[ "$pid" =~ ^[0-9]+$ && "$args" == *"$marker"* ]]; then
      printf '%s' "$pid"
      return 0
    fi
  done < <(docker exec "$container" ps -o pid,args)
  return 1
}

wait_worker_recovery() {
  local id="$1"
  local previous_restarts="$2"
  local state
  for _ in $(seq 1 160); do
    state="$(channel_status "$id" 2>/dev/null || true)"
    if [[ -n "$state" ]] && jq -e --argjson restarts "$previous_restarts" \
      '.outputReady and .compatibility.state == "ready" and .compatibility.worker.running and (.compatibility.worker.restarts > $restarts)' \
      <<<"$state" >/dev/null; then
      printf '%s' "$state"
      return 0
    fi
    sleep 0.25
  done
  return 1
}

create_push_channel "SRT transition resilience temporary" "$PUSH_PORT" || exit 2
transition_id="$created_id"
transition_path="$created_path"
printf 'Transition channel: %s (%s), port %s\n' "$transition_path" "$transition_id" "$PUSH_PORT"

start_source transition-direct direct "srt://$SRT_HOST:$PUSH_PORT?pkt_size=1316"
transition_pid="$last_pid"
if state="$(wait_ready "$transition_id" direct)" && result="$(probe_channel "$transition_id" 2>&1)"; then
  pass codec-transition-direct "$(jq -r '.bytesReceived' <<<"$result") WebRTC bytes"
else
  fail codec-transition-direct "$(channel_status "$transition_id" 2>/dev/null || true)"
fi
stop_source "$transition_pid"
if ! wait_offline "$transition_id"; then
  fail transition-disconnect "channel did not become offline"
fi

start_source transition-normalized normalized "srt://$SRT_HOST:$PUSH_PORT?pkt_size=1316"
transition_pid="$last_pid"
if state="$(wait_ready "$transition_id" transcoded)" && result="$(probe_channel "$transition_id" 2>&1)"; then
  pass codec-transition-normalized "$(jq -r '.bytesReceived' <<<"$result") WebRTC bytes"
else
  fail codec-transition-normalized "$(channel_status "$transition_id" 2>/dev/null || true)"
fi
stop_source "$transition_pid"
if ! wait_offline "$transition_id"; then
  fail transition-normalized-cleanup "channel did not become offline"
fi

start_source transition-direct-again direct "srt://$SRT_HOST:$PUSH_PORT?pkt_size=1316"
transition_pid="$last_pid"
if state="$(wait_ready "$transition_id" direct)" && jq -e '.compatibility.worker.running | not' <<<"$state" >/dev/null; then
  pass codec-transition-direct-again "worker stopped after incompatible source disconnected"
else
  fail codec-transition-direct-again "$(channel_status "$transition_id" 2>/dev/null || true)"
fi

declare -a viewer_pids=()
for viewer in $(seq 1 "$VIEWERS"); do
  WHEP_SAMPLE_MS=5000 node "$SCRIPT_DIR/whep-probe.mjs" \
    "$GATEWAY_URL/api/v1/channels/$transition_id/whep" \
    >"$work_dir/viewer-$viewer.json" 2>"$work_dir/viewer-$viewer.err" &
  viewer_pids+=("$!")
done
max_readers=0
for _ in $(seq 1 32); do
  state="$(channel_status "$transition_id" 2>/dev/null || true)"
  readers="$(jq -r '.readers | length' <<<"${state:-null}" 2>/dev/null || printf 0)"
  if ((readers > max_readers)); then
    max_readers="$readers"
  fi
  sleep 0.25
done
viewer_failures=0
for pid in "${viewer_pids[@]}"; do
  if ! wait "$pid"; then
    viewer_failures=$((viewer_failures + 1))
  fi
done
if ((viewer_failures == 0 && max_readers >= VIEWERS)); then
  pass concurrent-viewers "$VIEWERS viewers received media; observed $max_readers readers"
else
  fail concurrent-viewers "$viewer_failures probes failed; observed $max_readers/$VIEWERS readers"
fi
for _ in $(seq 1 40); do
  state="$(channel_status "$transition_id" 2>/dev/null || true)"
  if jq -e '.readers | length == 0' <<<"${state:-null}" >/dev/null 2>&1; then
    pass viewer-cleanup "all WHEP sessions were removed"
    break
  fi
  sleep 0.25
done
if [[ "$(jq -r '.readers | length' <<<"$(channel_status "$transition_id")")" != 0 ]]; then
  fail viewer-cleanup "WHEP readers remained after probes exited"
fi

create_push_channel "SRT isolation resilience temporary" "$ISOLATION_PORT" || exit 2
isolation_id="$created_id"
isolation_path="$created_path"
start_source isolation-normalized normalized "srt://$SRT_HOST:$ISOLATION_PORT?pkt_size=1316"
isolation_pid="$last_pid"
if state="$(wait_ready "$isolation_id" transcoded)"; then
  previous_restarts="$(jq -r '.compatibility.worker.restarts' <<<"$state")"
  if worker_pid="$(find_worker_pid "$isolation_id")"; then
    WHEP_SAMPLE_MS=5000 node "$SCRIPT_DIR/whep-probe.mjs" \
      "$GATEWAY_URL/api/v1/channels/$transition_id/whep" >"$work_dir/isolation-viewer.json" 2>"$work_dir/isolation-viewer.err" &
    isolation_viewer_pid=$!
    sleep 1
    container="$(docker compose ps -q gateway)"
    docker exec "$container" kill -KILL "$worker_pid"
    if wait "$isolation_viewer_pid"; then
      pass channel-isolation "direct viewer survived unrelated worker failure"
    else
      fail channel-isolation "$(<"$work_dir/isolation-viewer.err")"
    fi
    if state="$(wait_worker_recovery "$isolation_id" "$previous_restarts")" && result="$(probe_channel "$isolation_id" 2>&1)"; then
      pass worker-recovery "restart $(jq -r '.compatibility.worker.restarts' <<<"$state"), $(jq -r '.bytesReceived' <<<"$result") WebRTC bytes"
    else
      fail worker-recovery "$(channel_status "$isolation_id" 2>/dev/null || true)"
    fi
  else
    fail worker-recovery "could not locate compatibility worker"
  fi
else
  fail worker-recovery-setup "$(channel_status "$isolation_id" 2>/dev/null || true)"
fi

create_pull_channel || exit 2
pull_id="$created_id"
pull_path="$created_path"
printf 'Pull channel: %s (%s), source port %s\n' "$pull_path" "$pull_id" "$PULL_PORT"
pull_target="srt://:$PULL_PORT?mode=listener&pkt_size=1316&passphrase=$PULL_PASSPHRASE"
start_source pull-direct direct "$pull_target"
pull_pid="$last_pid"
if state="$(wait_ready "$pull_id" direct)" && result="$(probe_channel "$pull_id" 2>&1)"; then
  pass encrypted-srt-pull "direct, $(jq -r '.bytesReceived' <<<"$result") WebRTC bytes"
else
  fail encrypted-srt-pull "$(channel_status "$pull_id" 2>/dev/null || true)"
fi
stop_source "$pull_pid"
if ! wait_offline "$pull_id"; then
  fail srt-pull-disconnect "channel did not become offline"
fi
start_source pull-reconnect normalized "$pull_target"
pull_pid="$last_pid"
if state="$(wait_ready "$pull_id" transcoded)" && result="$(probe_channel "$pull_id" 2>&1)"; then
  pass srt-pull-reconnect "normalized, $(jq -r '.bytesReceived' <<<"$result") WebRTC bytes"
else
  fail srt-pull-reconnect "$(channel_status "$pull_id" 2>/dev/null || true)"
fi

stop_source "$transition_pid"
stop_source "$isolation_pid"
stop_source "$pull_pid"
wait_offline "$transition_id" || fail transition-final-cleanup "channel remained online"
wait_offline "$isolation_id" || fail isolation-final-cleanup "channel remained online"
wait_offline "$pull_id" || fail pull-final-cleanup "channel remained online"

printf '\nSummary: %d passed, %d failed\n' "$passes" "$failures"
if ((failures > 0)); then
  exit 1
fi
