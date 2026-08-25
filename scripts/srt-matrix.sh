#!/usr/bin/env bash

set -uo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:8080}"
SRT_HOST="${SRT_HOST:-127.0.0.1}"
SRT_PORT="${SRT_PORT:-11990}"
SRT_PULL_PORT="${SRT_PULL_PORT:-11991}"
RTP_TUNNEL_PORT="${RTP_TUNNEL_PORT:-12011}"
SOURCE_FILE="${SOURCE_FILE:-/home/magnus/Downloads/big_buck_bunny_1080p_h264.mov}"
READY_TIMEOUT_SECONDS="${READY_TIMEOUT_SECONDS:-20}"
WHEP_PROBE="${WHEP_PROBE:-1}"
CASE_FILTER="${CASE_FILTER:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

for executable in curl jq ffmpeg ffprobe srt-live-transmit; do
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
channel_id=""
channel_path=""
sender_pid=""
sender_aux_pid=""
passes=0
failures=0

stop_sender() {
  if [[ -n "$sender_pid" ]] && kill -0 "$sender_pid" 2>/dev/null; then
    kill "$sender_pid" 2>/dev/null || true
    wait "$sender_pid" 2>/dev/null || true
  fi
  sender_pid=""
	if [[ -n "$sender_aux_pid" ]] && kill -0 "$sender_aux_pid" 2>/dev/null; then
		kill "$sender_aux_pid" 2>/dev/null || true
		wait "$sender_aux_pid" 2>/dev/null || true
	fi
	sender_aux_pid=""
}

cleanup() {
  stop_sender
  if [[ -n "$channel_id" ]]; then
    curl --silent --output /dev/null --request DELETE "$GATEWAY_URL/api/v1/channels/$channel_id" || true
  fi
  rm -rf -- "$work_dir"
}
trap cleanup EXIT INT TERM

create_response="$(jq -n --argjson port "$SRT_PORT" '{
  name:"SRT matrix temporary",
  enabled:true,
  input:{mode:"srt-push",srt:{port:$port}},
  maxReaders:0,
  useAbsoluteTimestamp:true
}' | curl --fail --silent --show-error \
  --header 'Content-Type: application/json' --data-binary @- \
  "$GATEWAY_URL/api/v1/channels")" || exit 2
channel_id="$(jq -r '.id' <<<"$create_response")"
channel_path="$(jq -r '.path' <<<"$create_response")"

channel_status() {
  curl --fail --silent --show-error "$GATEWAY_URL/api/v1/status" |
    jq -c --arg id "$channel_id" '.channels[] | select(.id == $id)'
}

put_channel() {
  local revision
  revision="$(channel_status | jq -er '.revision')" || return
  curl --fail --silent --show-error --output /dev/null --request PUT \
    --header 'Content-Type: application/json' \
    --header "If-Match: \"$revision\"" \
    --data-binary @- "$GATEWAY_URL/api/v1/channels/$channel_id"
}

wait_offline() {
  local state
  for _ in $(seq 1 80); do
    state="$(channel_status 2>/dev/null || true)"
    if [[ -n "$state" ]] && jq -e '(.available | not) and (.compatibility.worker.running | not)' <<<"$state" >/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

wait_ready() {
  local state
  local attempts=$((READY_TIMEOUT_SECONDS * 4))
  for _ in $(seq 1 "$attempts"); do
    state="$(channel_status 2>/dev/null || true)"
    if [[ -n "$state" ]] && jq -e '.outputReady and .compatibility.state == "ready"' <<<"$state" >/dev/null; then
      printf '%s' "$state"
      return 0
    fi
    if [[ -n "$sender_pid" ]] && ! kill -0 "$sender_pid" 2>/dev/null; then
      break
    fi
    sleep 0.25
  done
  return 1
}

start_sender() {
  local case_name="$1"
  local target="$2"
  local log_file="$work_dir/${case_name}.log"
  local -a input
  local -a output

  case "$case_name" in
    h264-baseline-opus|direct-streamid|passphrase-correct|pull-h264-baseline-opus)
      input=(-re -f lavfi -i testsrc2=size=640x360:rate=30 -re -f lavfi -i sine=frequency=1000:sample_rate=48000)
      output=(-map 0:v:0 -map 1:a:0 -c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline -pix_fmt yuv420p -bf 0 -g 30 -c:a libopus -application lowdelay -b:a 96k)
      ;;
    h264-high-no-b-opus)
      input=(-re -f lavfi -i testsrc2=size=640x360:rate=30 -re -f lavfi -i sine=frequency=1100:sample_rate=48000)
      output=(-map 0:v:0 -map 1:a:0 -c:v libx264 -preset veryfast -tune zerolatency -profile:v high -pix_fmt yuv420p -bf 0 -g 30 -c:a libopus -application lowdelay -b:a 96k)
      ;;
    h264-main-bframes-opus)
      input=(-re -f lavfi -i testsrc2=size=640x360:rate=30 -re -f lavfi -i sine=frequency=1200:sample_rate=48000)
      output=(-map 0:v:0 -map 1:a:0 -c:v libx264 -preset veryfast -profile:v main -pix_fmt yuv420p -bf 3 -g 30 -c:a libopus -application lowdelay -b:a 96k)
      ;;
	  h264-interlaced-opus)
		input=(-re -f lavfi -i testsrc2=size=720x576:rate=25 -re -f lavfi -i sine=frequency=1250:sample_rate=48000)
		output=(-map 0:v:0 -map 1:a:0 -vf setfield=tff -c:v libx264 -preset ultrafast -profile:v main -pix_fmt yuv420p -flags +ilme+ildct -x264-params tff=1:bframes=0:keyint=25 -c:a libopus -application lowdelay -b:a 96k)
		;;
    h264-baseline-aac)
      input=(-re -f lavfi -i testsrc2=size=640x360:rate=30 -re -f lavfi -i sine=frequency=1300:sample_rate=48000)
      output=(-map 0:v:0 -map 1:a:0 -c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline -pix_fmt yuv420p -bf 0 -g 30 -c:a aac -b:a 128k -ac 2)
      ;;
    h265-opus)
      input=(-re -f lavfi -i testsrc2=size=640x360:rate=30 -re -f lavfi -i sine=frequency=1400:sample_rate=48000)
      output=(-map 0:v:0 -map 1:a:0 -c:v libx265 -preset ultrafast -x265-params pools=1:frame-threads=1:keyint=30:bframes=0 -c:a libopus -application lowdelay -b:a 96k)
      ;;
    h265-aac)
      input=(-re -f lavfi -i testsrc2=size=640x360:rate=30 -re -f lavfi -i sine=frequency=1500:sample_rate=48000)
      output=(-map 0:v:0 -map 1:a:0 -c:v libx265 -preset ultrafast -x265-params pools=1:frame-threads=1:keyint=30:bframes=0 -c:a aac -b:a 128k -ac 2)
      ;;
    mpeg2-mp2)
      input=(-re -f lavfi -i testsrc2=size=640x360:rate=30 -re -f lavfi -i sine=frequency=1600:sample_rate=48000)
      output=(-map 0:v:0 -map 1:a:0 -c:v mpeg2video -g 30 -b:v 2M -c:a mp2 -b:a 192k -ac 2)
      ;;
	  mpeg2-interlaced-mp2)
		input=(-re -f lavfi -i testsrc2=size=720x576:rate=25 -re -f lavfi -i sine=frequency=1650:sample_rate=48000)
		output=(-map 0:v:0 -map 1:a:0 -vf setfield=tff -c:v mpeg2video -flags +ilme+ildct -g 25 -b:v 3M -c:a mp2 -b:a 192k -ac 2)
		;;
    mpeg4-ac3)
      input=(-re -f lavfi -i testsrc2=size=640x360:rate=30 -re -f lavfi -i sine=frequency=1700:sample_rate=48000)
      output=(-map 0:v:0 -map 1:a:0 -c:v mpeg4 -g 30 -bf 0 -q:v 5 -c:a ac3 -b:a 384k -ac 2)
      ;;
    mpeg4-opus)
      input=(-re -f lavfi -i testsrc2=size=640x360:rate=30 -re -f lavfi -i sine=frequency=1750:sample_rate=48000)
      output=(-map 0:v:0 -map 1:a:0 -c:v mpeg4 -g 30 -bf 0 -q:v 5 -c:a libopus -application lowdelay -b:a 96k)
      ;;
    h264-baseline-ac3)
      input=(-re -f lavfi -i testsrc2=size=640x360:rate=30 -re -f lavfi -i sine=frequency=1775:sample_rate=48000)
      output=(-map 0:v:0 -map 1:a:0 -c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline -pix_fmt yuv420p -bf 0 -g 30 -c:a ac3 -b:a 384k -ac 2)
      ;;
    h264-baseline-ac3-192)
      input=(-re -f lavfi -i testsrc2=size=640x360:rate=30 -re -f lavfi -i sine=frequency=1775:sample_rate=48000)
      output=(-map 0:v:0 -map 1:a:0 -c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline -pix_fmt yuv420p -bf 0 -g 30 -c:a ac3 -b:a 192k -ac 2)
      ;;
    h264-video-only)
      input=(-re -f lavfi -i testsrc2=size=640x360:rate=30)
      output=(-map 0:v:0 -an -c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline -pix_fmt yuv420p -bf 0 -g 30)
      ;;
    h265-video-only)
      input=(-re -f lavfi -i testsrc2=size=640x360:rate=30)
      output=(-map 0:v:0 -an -c:v libx265 -preset ultrafast -x265-params pools=1:frame-threads=1:keyint=30:bframes=0)
      ;;
    opus-audio-only)
      input=(-re -f lavfi -i sine=frequency=1800:sample_rate=48000)
      output=(-vn -map 0:a:0 -c:a libopus -application lowdelay -b:a 96k)
      ;;
    aac-audio-only)
      input=(-re -f lavfi -i sine=frequency=1900:sample_rate=48000)
      output=(-vn -map 0:a:0 -c:a aac -b:a 128k -ac 2)
      ;;
    mp3-audio-only)
      input=(-re -f lavfi -i sine=frequency=2000:sample_rate=48000)
      output=(-vn -map 0:a:0 -c:a libmp3lame -b:a 128k -ac 2)
      ;;
    source-file-copy)
      input=(-re -stream_loop -1 -i "$SOURCE_FILE")
      output=(-map 0:v:0 -map 0:a:0 -c copy)
      ;;
	  rtp-mp2t-h264-aac|pull-rtp-mp2t-h264-aac)
		input=(-re -f lavfi -i testsrc2=size=640x360:rate=30 -re -f lavfi -i sine=frequency=2100:sample_rate=48000)
		output=(-map 0:v:0 -map 1:a:0 -c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline -pix_fmt yuv420p -bf 0 -g 30 -c:a aac -b:a 128k -ac 2)
		ffmpeg -hide_banner -loglevel error -nostdin "${input[@]}" "${output[@]}" \
		  -mpegts_flags resend_headers -rtp_muxer_options "rtpflags=skip_rtcp:payload_type=33" \
		  -f rtp_mpegts "$target" >"$log_file" 2>&1 &
		sender_pid=$!
		return
		;;
	  elementary-rtp-h264-opus|pull-elementary-rtp-h264-opus)
		srt-live-transmit -q -a:no -st:no -c:1456 -buffering:1000 "udp://:$RTP_TUNNEL_PORT" "$target" >"$log_file" 2>&1 &
		sender_aux_pid=$!
		# The UDP bridge does not backpressure while its SRT handshake is in progress.
		# Its SRT listener is serviced only after UDP input arrives, so prime pull mode
		# with RTCP receiver reports that Gateway intentionally drops.
		if [[ "$target" == *"mode=listener"* ]]; then
			for _ in $(seq 1 12); do
				printf '\x80\xc9\x00\x01\x00\x00\x00\x00' >/dev/udp/127.0.0.1/"$RTP_TUNNEL_PORT"
				sleep 0.25
			done
			ffmpeg -hide_banner -loglevel error -nostdin -re \
				-f lavfi -i sine=frequency=2200:sample_rate=48000 -t 2 \
				-c:a libopus -application lowdelay -ac 2 -ar 48000 -b:a 96k \
				-payload_type 97 -f rtp "udp://127.0.0.1:$RTP_TUNNEL_PORT?pkt_size=1200" \
				>>"$log_file" 2>&1
			sleep 0.5
		else
			sleep 2
		fi
		ffmpeg -hide_banner -loglevel error -nostdin \
		  -re -f lavfi -i testsrc2=size=640x360:rate=30 \
		  -re -f lavfi -i sine=frequency=2200:sample_rate=48000 \
		  -map 0:v:0 -map 1:a:0 \
		  -c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline -pix_fmt yuv420p -bf 0 -g 30 -x264-params slice-max-size=900 \
		  -c:a libopus -application lowdelay -ac 2 -ar 48000 -b:a 96k \
		  -f tee "[select=v:f=rtp:payload_type=96:rtpflags=skip_rtcp]udp://127.0.0.1:$RTP_TUNNEL_PORT?pkt_size=1200|[select=a:f=rtp:payload_type=97:rtpflags=skip_rtcp]udp://127.0.0.1:$RTP_TUNNEL_PORT?pkt_size=1200" \
		  >>"$log_file" 2>&1 &
		sender_pid=$!
		return
		;;
    *)
      printf 'unknown sender case: %s\n' "$case_name" >&2
      return 2
      ;;
  esac

  ffmpeg -hide_banner -loglevel error -nostdin "${input[@]}" "${output[@]}" \
    -f mpegts "$target" >"$log_file" 2>&1 &
  sender_pid=$!
}

record_failure() {
  local case_name="$1"
  local message="$2"
  failures=$((failures + 1))
  printf '%-28s FAIL  %s\n' "$case_name" "$message"
  if [[ -s "$work_dir/${case_name}.log" ]]; then
    tail -n 8 "$work_dir/${case_name}.log" >&2
  fi
}

run_case() {
  local case_name="$1"
  local expected_mode="$2"
  local expected_input="$3"
  local expected_output="$4"
  local target="${5:-srt://$SRT_HOST:$SRT_PORT?pkt_size=1316}"
  local state
  local started
  local finished
  local latency
  local actual_mode
  local actual_input
  local actual_output
  local worker
  local whep_result
	local expected_min_fps="${6:-}"
	if [[ -n "$CASE_FILTER" && "$case_name" != *"$CASE_FILTER"* ]]; then
		return
	fi

  if ! wait_offline; then
    record_failure "$case_name" "previous source did not clean up"
    return
  fi
  start_sender "$case_name" "$target" || {
    record_failure "$case_name" "could not start sender"
    return
  }
  started="$(date +%s%3N)"
  if ! state="$(wait_ready)"; then
    state="$(channel_status 2>/dev/null || true)"
    record_failure "$case_name" "not ready: $(jq -c '{online,tracks,compatibility}' <<<"${state:-null}")"
    stop_sender
    wait_offline || true
    return
  fi
  finished="$(date +%s%3N)"
  latency=$((finished - started))
  actual_mode="$(jq -r '.compatibility.mode' <<<"$state")"
  actual_input="$(jq -r '[.tracks[].codec] | join(",")' <<<"$state")"
  actual_output="$(jq -r '[.outputTracks[].codec] | join(",")' <<<"$state")"
  worker="$(jq -r '.compatibility.worker.running' <<<"$state")"

  if [[ "$actual_mode" != "$expected_mode" || "$actual_input" != "$expected_input" || "$actual_output" != "$expected_output" ]]; then
    record_failure "$case_name" "mode/input/output=$actual_mode/$actual_input/$actual_output, expected $expected_mode/$expected_input/$expected_output"
  elif [[ "$expected_mode" == direct && "$worker" != false ]]; then
    record_failure "$case_name" "direct source spawned a compatibility worker"
  elif [[ "$expected_mode" == transcoded && "$worker" != true ]]; then
    record_failure "$case_name" "normalized source has no running worker"
  elif [[ "$(jq -r '.inboundFramesInError' <<<"$state")" != 0 ]]; then
    record_failure "$case_name" "MediaMTX reported inbound frame errors"
  elif [[ "$WHEP_PROBE" == 1 ]]; then
    if ! whep_result="$(node "$SCRIPT_DIR/whep-probe.mjs" "$GATEWAY_URL/api/v1/channels/$channel_id/whep" 2>&1)"; then
      record_failure "$case_name" "WHEP probe failed: $whep_result"
	elif [[ -n "$expected_min_fps" ]] && ! jq -e --argjson minimum "$expected_min_fps" \
	  '.sampleDurationMS as $duration | [.inbound[] | select(.kind == "video") | (.sampleFramesDecoded * 1000 / $duration)] | length > 0 and max >= $minimum' \
	  <<<"$whep_result" >/dev/null; then
		record_failure "$case_name" "deinterlaced browser cadence below ${expected_min_fps} fps: $whep_result"
	else
      passes=$((passes + 1))
      printf '%-28s PASS  %5d ms  %-10s %-20s WebRTC %s bytes\n' \
        "$case_name" "$latency" "$actual_mode" "$actual_output" "$(jq -r '.bytesReceived' <<<"$whep_result")"
    fi
  else
    passes=$((passes + 1))
    printf '%-28s PASS  %5d ms  %-10s %s\n' "$case_name" "$latency" "$actual_mode" "$actual_output"
  fi

  stop_sender
  if ! wait_offline; then
    record_failure "$case_name-cleanup" "source or compatibility worker remained online"
  fi
}

set_elementary_sdp() {
	local sdp="$1"
	jq -n --argjson port "$SRT_PORT" --arg sdp "$sdp" '{
		name:"SRT matrix temporary",
		enabled:true,
		input:{mode:"srt-push",srt:{port:$port,sdp:$sdp}},
		maxReaders:0,
		useAbsoluteTimestamp:true
	}' | put_channel
}

set_pull_config() {
	local sdp="${1:-}"
	jq -n --arg host "$SRT_HOST" --argjson port "$SRT_PULL_PORT" --arg sdp "$sdp" '{
		name:"SRT matrix temporary",
		enabled:true,
		input:{mode:"srt-pull",srt:{host:$host,port:$port,latencyMs:500,sdp:$sdp}},
		maxReaders:0,
		useAbsoluteTimestamp:true
	}' | put_channel
}

set_passphrase() {
  local passphrase="$1"
  local passphrase_json
  if [[ -n "$passphrase" ]]; then
    passphrase_json="$(jq -n --arg value "$passphrase" '{passphrase:$value}')"
  else
    passphrase_json='{"clearPassphrase":true}'
  fi
  jq -n --argjson port "$SRT_PORT" --argjson srt "$passphrase_json" '{
    name:"SRT matrix temporary",
    enabled:true,
    input:{mode:"srt-push",srt:({port:$port} + $srt)},
    maxReaders:0,
    useAbsoluteTimestamp:true
  }' | put_channel
}

test_wrong_passphrase() {
  local state
  local case_name="passphrase-wrong"
	if [[ -n "$CASE_FILTER" && "$case_name" != *"$CASE_FILTER"* ]]; then
		return
	fi
  set_passphrase "matrix-passphrase"
  sleep 0.5
  start_sender h264-baseline-opus "srt://$SRT_HOST:$SRT_PORT?pkt_size=1316&passphrase=wrong-passphrase" || {
    record_failure "$case_name" "could not start sender"
    return
  }
  sleep 4
  state="$(channel_status)"
  if jq -e '.online or .outputReady' <<<"$state" >/dev/null; then
    record_failure "$case_name" "incorrect passphrase was accepted"
  else
    passes=$((passes + 1))
    printf '%-28s PASS  rejected and remained offline\n' "$case_name"
  fi
  stop_sender
  wait_offline || true
}

test_unsupported_ac3_framing() {
  local case_name="ac3-192-multiframe-rejected"
  local state
	if [[ -n "$CASE_FILTER" && "$case_name" != *"$CASE_FILTER"* ]]; then
		return
	fi
  if ! wait_offline; then
    record_failure "$case_name" "previous source did not clean up"
    return
  fi
  start_sender h264-baseline-ac3-192 "srt://$SRT_HOST:$SRT_PORT?pkt_size=1316" || {
    record_failure "$case_name" "could not start sender"
    return
  }
  for _ in $(seq 1 80); do
    state="$(channel_status 2>/dev/null || true)"
    if [[ -n "$state" ]] && jq -e \
		'(.outputReady | not) and .compatibility.state == "error" and ((.compatibility.lastError // "") | length > 0)' \
      <<<"$state" >/dev/null; then
      passes=$((passes + 1))
      printf '%-28s PASS  failed visibly without publishing an output\n' "$case_name"
      stop_sender
      wait_offline || record_failure "$case_name-cleanup" "worker remained after source disconnected"
      return
    fi
    sleep 0.25
  done
  record_failure "$case_name" "expected visible compatibility rejection: $(jq -c '{outputReady,compatibility}' <<<"${state:-null}")"
  stop_sender
  wait_offline || true
}

printf 'Temporary channel: %s (%s), SRT port %s\n' "$channel_path" "$channel_id" "$SRT_PORT"
run_case h264-baseline-opus direct 'H264,Opus' 'H264,Opus'
run_case h264-high-no-b-opus direct 'H264,Opus' 'H264,Opus'
run_case h264-main-bframes-opus transcoded 'H264,Opus' 'H264,Opus'
run_case h264-interlaced-opus transcoded 'H264,Opus' 'H264,Opus' '' 40
run_case h264-baseline-aac transcoded 'H264,MPEG-4 Audio' 'H264,Opus'
run_case h265-opus transcoded 'H265,Opus' 'H264,Opus'
run_case h265-aac transcoded 'H265,MPEG-4 Audio' 'H264,Opus'
run_case mpeg2-mp2 transcoded 'MPEG-1/2 Video,MPEG-1/2 Audio' 'H264,Opus'
run_case mpeg2-interlaced-mp2 transcoded 'MPEG-1/2 Video,MPEG-1/2 Audio' 'H264,Opus' '' 40
run_case mpeg4-opus transcoded 'MPEG-4 Video,Opus' 'H264,Opus'
run_case h264-baseline-ac3 transcoded 'H264,AC3' 'H264,Opus'
test_unsupported_ac3_framing
run_case mpeg4-ac3 transcoded 'MPEG-4 Video,AC3' 'H264,Opus'
run_case h264-video-only direct 'H264' 'H264'
run_case h265-video-only transcoded 'H265' 'H264'
run_case opus-audio-only direct 'Opus' 'Opus'
run_case aac-audio-only transcoded 'MPEG-4 Audio' 'Opus'
run_case mp3-audio-only transcoded 'MPEG-1/2 Audio' 'Opus'
if [[ -f "$SOURCE_FILE" ]]; then
  run_case source-file-copy transcoded 'H264,MPEG-4 Audio' 'H264,Opus'
else
  printf '%-28s SKIP  source file not found: %s\n' source-file-copy "$SOURCE_FILE"
fi

test_wrong_passphrase
run_case passphrase-correct direct 'H264,Opus' 'H264,Opus' \
  "srt://$SRT_HOST:$SRT_PORT?pkt_size=1316&passphrase=matrix-passphrase"
set_passphrase ""
sleep 0.5
run_case rtp-mp2t-h264-aac transcoded 'H264,MPEG-4 Audio' 'H264,Opus' \
	"srt://$SRT_HOST:$SRT_PORT?mode=caller&transtype=live&messageapi=1&payload_size=1456"
elementary_sdp=$'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=RTP over SRT matrix\r\nc=IN IP4 0.0.0.0\r\nt=0 0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=1\r\nm=audio 0 RTP/AVP 97\r\na=rtpmap:97 opus/48000/2\r\na=fmtp:97 sprop-stereo=1\r\n'
set_elementary_sdp "$elementary_sdp"
sleep 0.5
run_case elementary-rtp-h264-opus direct 'H264,Opus' 'H264,Opus' \
	"srt://$SRT_HOST:$SRT_PORT?mode=caller&transtype=live&messageapi=1&payloadsize=1456"
set_pull_config ""
sleep 0.5
run_case pull-h264-baseline-opus direct 'H264,Opus' 'H264,Opus' \
	"srt://0.0.0.0:$SRT_PULL_PORT?mode=listener&transtype=live&pkt_size=1316"
run_case pull-rtp-mp2t-h264-aac transcoded 'H264,MPEG-4 Audio' 'H264,Opus' \
	"srt://0.0.0.0:$SRT_PULL_PORT?mode=listener&transtype=live&messageapi=1&payload_size=1456"
set_pull_config "$elementary_sdp"
sleep 0.5
run_case pull-elementary-rtp-h264-opus direct 'H264,Opus' 'H264,Opus' \
	"srt://0.0.0.0:$SRT_PULL_PORT?mode=listener&transtype=live&messageapi=1&payloadsize=1456"
set_passphrase ""
sleep 0.5
run_case direct-streamid direct 'H264,Opus' 'H264,Opus' \
  "srt://$SRT_HOST:8890?pkt_size=1316&streamid=publish:$channel_path"

printf '\nSummary: %d passed, %d failed\n' "$passes" "$failures"
if ((failures > 0)); then
  exit 1
fi
