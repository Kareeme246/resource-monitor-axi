/**
 * The one POSIX sh script every host runs. It is piped to `sh -s` over ssh, so
 * nothing is installed remotely and the login shell (zsh, bash, fish) never
 * parses it. It prints `key=value` lines and never fails on a missing tool:
 * a metric that cannot be read is simply absent.
 *
 * The whole body sits in one brace group with stdin on /dev/null, so no tool
 * inside can swallow the rest of the script from the ssh stream.
 */
export const REMOTE_SCRIPT = String.raw`{
os=$(uname -s)
echo "os=$os"
echo "host=$(hostname 2>/dev/null)"
case "$os" in
Darwin)
  echo "cores=$(sysctl -n hw.ncpu 2>/dev/null)"
  echo "model=$(sysctl -n hw.model 2>/dev/null)"
  echo "chip=$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
  echo "memtotal=$(sysctl -n hw.memsize 2>/dev/null)"
  echo "load=$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}')"
  echo "memfree=$(memory_pressure 2>/dev/null | awk '/free percentage/ {gsub("%","",$NF); print $NF}')"
  echo "pressure=$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null)"
  echo "swap=$(sysctl -n vm.swapusage 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="used") {print $(i+2); exit}}')"
  echo "disk=$(df -k /System/Volumes/Data 2>/dev/null | awk 'NR==2 {print $2, $4}')"
  echo "gpu=$(ioreg -r -d 1 -w0 -c IOAccelerator 2>/dev/null | grep -o '"Device Utilization %"=[0-9]*' | head -1 | cut -d= -f2)"
  ps -axo comm= 2>/dev/null | awk '
    { n = split($0, p, "/"); b = p[n] }
    b == "launchd_sim" { sims++ }
    b == "xcodebuild" { xcb++ }
    END { print "sims=" sims + 0; print "xcodebuild=" xcb + 0 }'
  echo "cpu=$(top -l 2 -n 0 -s 1 2>/dev/null | awk '/^CPU usage/ {v = $3 + $5} END {print v}')"
  ;;
Linux)
  echo "cores=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)"
  echo "chip=$(awk -F': ' '/model name/ {print $2; exit}' /proc/cpuinfo 2>/dev/null)"
  echo "memtotal=$(awk '/^MemTotal:/ {print $2 * 1024}' /proc/meminfo 2>/dev/null)"
  echo "load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
  echo "memfree=$(awk '/^MemTotal:/ {t=$2} /^MemAvailable:/ {a=$2} END {if (t) printf "%d", a * 100 / t}' /proc/meminfo 2>/dev/null)"
  echo "psi=$(awk '/^some/ {split($2, a, "="); print a[2]}' /proc/pressure/memory 2>/dev/null)"
  echo "swap=$(awk '/^SwapTotal:/ {t=$2} /^SwapFree:/ {f=$2} END {printf "%dM", (t - f) / 1024}' /proc/meminfo 2>/dev/null)"
  echo "disk=$(df -Pk / 2>/dev/null | awk 'NR==2 {print $2, $4}')"
  if command -v nvidia-smi >/dev/null 2>&1; then
    echo "gpu=$(nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null | awk '{s += $1; n++} END {if (n) printf "%d", s / n}')"
  fi
  a=$(awk '/^cpu / {print $2+$3+$4+$5+$6+$7+$8, $5+$6}' /proc/stat 2>/dev/null)
  sleep 1
  b=$(awk '/^cpu / {print $2+$3+$4+$5+$6+$7+$8, $5+$6}' /proc/stat 2>/dev/null)
  echo "cpu=$(echo "$a $b" | awk '{dt = $3 - $1; di = $4 - $2; if (dt > 0) printf "%.1f", (dt - di) * 100 / dt}')"
  ;;
esac
echo "end=1"
} </dev/null
exit
`;
