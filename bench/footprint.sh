#!/bin/bash
# Sample total RSS (MB) and CPU (% of one core) of processes whose command matches $2, every 5 s for $3 seconds.
# usage: footprint.sh <label> <pgrep -f pattern> <seconds>
LABEL=$1; PAT=$2; SECS=${3:-300}; OUT=${OUT:-$(dirname "$0")/footprint-$LABEL.json}
CLK=$(getconf CLK_TCK); declare -a RSS
ticks() { local t=0; for p in $(pgrep -f "$PAT"); do [ -r /proc/$p/stat ] && t=$((t + $(awk '{print $14+$15}' /proc/$p/stat))); done; echo $t; }
rss() { local r=0; for p in $(pgrep -f "$PAT"); do [ -r /proc/$p/status ] && r=$((r + $(awk '/VmRSS/{print $2}' /proc/$p/status))); done; echo $((r/1024)); }
T0=$(ticks); S0=$(date +%s.%N); MAX=0; SUM=0; N=0
for i in $(seq 1 $((SECS/5))); do sleep 5; R=$(rss); SUM=$((SUM+R)); N=$((N+1)); [ $R -gt $MAX ] && MAX=$R; done
T1=$(ticks); S1=$(date +%s.%N)
# float math (bc with scale=2 truncated the intermediate division and rounded every value down to whole percents)
CPU=$(awk -v t="$(($T1-$T0))" -v clk="$CLK" -v s0="$S0" -v s1="$S1" 'BEGIN{printf "%.3f", t/clk/(s1-s0)*100}')
echo "{\"label\":\"$LABEL\",\"pattern\":\"$PAT\",\"seconds\":$SECS,\"procs\":$(pgrep -fc "$PAT"),\"cpu_ticks\":$(($T1-$T0)),\"rss_avg_mb\":$((SUM/N)),\"rss_max_mb\":$MAX,\"cpu_pct_avg\":$CPU}" | tee $OUT
