#!/bin/bash
# sync-and-process.sh — 本地同步处理脚本
#
# 工作流:
#   1. 从服务器拉取 pending 状态的任务列表
#   2. 下载原始视频到本地 tmp/
#   3. 用 echocut burn 处理
#   4. 把成片传回服务器
#   5. 更新任务状态为 done
#
# 用法:
#   ./scripts/sync-and-process.sh                 # 单次执行
#   ./scripts/sync-and-process.sh --loop 120      # 每 120 秒轮询
#
# 环境变量:
#   ECHO_SERVER     默认 https://example.com
#   ECHO_SSH        默认 root@14.103.216.255
#   ECHO_ADMIN_USER 默认 admin
#   ECHO_ADMIN_PASS 默认 echo2026

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

SERVER="${ECHO_SERVER:-https://example.com}"
SSH_HOST="${ECHO_SSH:-root@14.103.216.255}"
ADMIN_USER="${ECHO_ADMIN_USER:-admin}"
ADMIN_PASS="${ECHO_ADMIN_PASS:-echo2026}"
LOCAL_TMP="$PROJECT_ROOT/tmp/sync"
COOKIE_JAR="$LOCAL_TMP/.cookie"

C_GREEN='\033[32m'
C_YELLOW='\033[33m'
C_RED='\033[31m'
C_GRAY='\033[90m'
C_BOLD='\033[1m'
C_RESET='\033[0m'

log()  { echo -e "${C_GRAY}[$(date +%H:%M:%S)]${C_RESET} $*"; }
ok()   { echo -e "${C_GREEN}✓${C_RESET} $*"; }
warn() { echo -e "${C_YELLOW}!${C_RESET} $*"; }
err()  { echo -e "${C_RED}✗${C_RESET} $*"; }

mkdir -p "$LOCAL_TMP"

# ─── 登录拿 session ───────────────────────────
login() {
    local resp
    resp=$(curl -s -X POST "$SERVER/api/auth/login" \
        -H 'Content-Type: application/json' \
        -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" \
        -c "$COOKIE_JAR" 2>&1)
    if echo "$resp" | grep -q '"ok":true'; then
        return 0
    else
        err "登录失败: $resp"
        return 1
    fi
}

# ─── 获取 pending 任务 ─────────────────────────
get_pending_tasks() {
    curl -s "$SERVER/api/admin/tasks" -b "$COOKIE_JAR" 2>/dev/null \
        | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    tasks = data.get('tasks', [])
    pending = [t for t in tasks if t.get('status') == 'pending']
    for t in pending:
        print(f\"{t['id']}|{t['user_id']}|{t['upload_path']}|{t['original_filename']}\")
except:
    pass
" 2>/dev/null
}

# ─── 更新任务状态 ──────────────────────────────
update_task_status() {
    local task_id="$1" status="$2"
    curl -s -X PUT "$SERVER/api/admin/tasks/$task_id" \
        -H 'Content-Type: application/json' \
        -d "{\"status\":\"$status\"}" \
        -b "$COOKIE_JAR" > /dev/null 2>&1
}

# ─── 处理单个任务 ──────────────────────────────
process_task() {
    local task_id="$1"
    local user_id="$2"
    local upload_path="$3"
    local original_name="$4"

    log "${C_BOLD}[Task #$task_id]${C_RESET} $original_name (user=$user_id)"

    # 1. 下载视频
    local local_video="$LOCAL_TMP/$task_id-$original_name"
    log "  下载 $SSH_HOST:$upload_path ..."
    if ! scp -q "$SSH_HOST:$upload_path" "$local_video" 2>/dev/null; then
        err "  下载失败"
        update_task_status "$task_id" "failed"
        return 1
    fi
    ok "  下载完成 $(du -h "$local_video" | cut -f1)"

    # 2. 获取用户的 brand 配置(如果有)
    local brand_arg=""
    local brand_dir="$PROJECT_ROOT/configs/brands"
    # 尝试从服务器获取用户的 brand 信息
    local brand_json
    brand_json=$(curl -s "$SERVER/api/admin/tasks" -b "$COOKIE_JAR" 2>/dev/null \
        | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    tasks = data.get('tasks', [])
    task = next((t for t in tasks if t['id'] == $task_id), None)
    if task and task.get('username'):
        print(task['username'])
except:
    pass
" 2>/dev/null)
    if [ -n "$brand_json" ] && [ -f "$brand_dir/$brand_json.json" ]; then
        brand_arg="--brand $brand_json"
        log "  品牌: $brand_json"
    fi

    # 3. 更新状态为 processing
    update_task_status "$task_id" "processing"

    # 4. 本地处理
    log "  开始处理..."
    local output_dir
    if echocut burn "$local_video" --cut-fillers --cut-silence $brand_arg 2>&1 | tee "$LOCAL_TMP/$task_id.log" | tail -5; then
        # 找到输出文件
        output_dir=$(grep -o 'output: .*' "$LOCAL_TMP/$task_id.log" | head -1 | sed 's/output: //')
        if [ -z "$output_dir" ]; then
            output_dir=$(ls -td "$PROJECT_ROOT/debug_outputs/video/"* 2>/dev/null | head -1)
        fi
    else
        err "  处理失败"
        update_task_status "$task_id" "failed"
        rm -f "$local_video"
        return 1
    fi

    # 5. 找到成片并上传
    local burn_file
    burn_file=$(find "$output_dir" -name '*_burn.mp4' 2>/dev/null | head -1)
    if [ -z "$burn_file" ]; then
        err "  找不到成片"
        update_task_status "$task_id" "failed"
        rm -f "$local_video"
        return 1
    fi

    local remote_output="/mnt/data/echo/outputs/${task_id}-$(basename "$burn_file")"
    log "  上传成片到 $SSH_HOST ..."
    if scp -q "$burn_file" "$SSH_HOST:$remote_output" 2>/dev/null; then
        ok "  上传完成"
        # 更新任务状态和输出路径
        curl -s -X PUT "$SERVER/api/admin/tasks/$task_id" \
            -H 'Content-Type: application/json' \
            -d "{\"status\":\"done\",\"output_path\":\"$remote_output\"}" \
            -b "$COOKIE_JAR" > /dev/null 2>&1
        ok "  [Task #$task_id] 处理完成 ✓"
    else
        err "  上传失败"
        update_task_status "$task_id" "failed"
    fi

    # 6. 清理本地临时文件
    rm -f "$local_video"
}

# ─── 主循环 ────────────────────────────────────
run_once() {
    log "${C_BOLD}同步检查${C_RESET} $SERVER"

    if ! login; then
        return 1
    fi

    local tasks
    tasks=$(get_pending_tasks)
    if [ -z "$tasks" ]; then
        log "  没有 pending 任务"
        return 0
    fi

    local count
    count=$(echo "$tasks" | wc -l | tr -d ' ')
    log "  发现 ${C_BOLD}$count${C_RESET} 个 pending 任务"

    echo "$tasks" | while IFS='|' read -r task_id user_id upload_path original_name; do
        process_task "$task_id" "$user_id" "$upload_path" "$original_name"
    done
}

# ─── 入口 ──────────────────────────────────────
if [ "${1:-}" = "--loop" ]; then
    interval="${2:-120}"
    log "${C_BOLD}循环模式${C_RESET} 每 ${interval}s 检查一次 (Ctrl+C 停止)"
    while true; do
        run_once || true
        log "${C_GRAY}等待 ${interval}s...${C_RESET}"
        sleep "$interval"
    done
else
    run_once
fi
