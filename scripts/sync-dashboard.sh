#!/bin/bash
# sync-dashboard.sh — 同步处理监控面板
#
# 在一个终端窗口实时显示:
#   - 服务器任务队列状态(pending/processing/done)
#   - 本地正在处理的任务进度
#   - 用户上传活动
#
# 用法:
#   ./scripts/sync-dashboard.sh                   # 只看状态
#   ./scripts/sync-dashboard.sh --process         # 看状态 + 自动处理
#   ./scripts/sync-dashboard.sh --process --loop   # 持续轮询处理
#
# 依赖: curl, ssh, jq(可选)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

SERVER="${ECHO_SERVER:-https://example.com}"
SSH_HOST="${ECHO_SSH:-root@14.103.216.255}"
ADMIN_USER="${ECHO_ADMIN_USER:-admin}"
ADMIN_PASS="${ECHO_ADMIN_PASS:-Echo@2026!zd}"
COOKIE_JAR="$PROJECT_ROOT/tmp/sync/.dashboard-cookie"
INTERVAL="${ECHO_POLL_INTERVAL:-60}"
AUTO_PROCESS="${1:-}"
LOOP_MODE="${2:-}"

# Colors
C_BOLD='\033[1m'
C_DIM='\033[2m'
C_GREEN='\033[32m'
C_YELLOW='\033[33m'
C_RED='\033[31m'
C_BLUE='\033[34m'
C_CYAN='\033[36m'
C_MAGENTA='\033[35m'
C_RESET='\033[0m'

mkdir -p "$PROJECT_ROOT/tmp/sync"

# ─── Login ───
login() {
    curl -s -X POST "$SERVER/api/auth/login" \
        -H 'Content-Type: application/json' \
        -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" \
        -c "$COOKIE_JAR" > /dev/null 2>&1
}

# ─── Fetch tasks ───
fetch_tasks() {
    curl -s "$SERVER/api/admin/tasks" -b "$COOKIE_JAR" 2>/dev/null
}

# ─── Fetch users ───
fetch_users() {
    curl -s "$SERVER/api/admin/users" -b "$COOKIE_JAR" 2>/dev/null
}

# ─── Dashboard render ───
render_dashboard() {
    clear
    local NOW
    NOW=$(date '+%Y-%m-%d %H:%M:%S')

    echo -e "${C_BOLD}${C_CYAN}⚡ echocut — 同步监控面板${C_RESET}"
    echo -e "${C_DIM}$NOW | 服务器: $SERVER | 轮询: ${INTERVAL}s${C_RESET}"
    echo -e "${C_DIM}────────────────────────────────────────────────────${C_RESET}"

    # Login
    login 2>/dev/null

    # Fetch data
    local TASKS_JSON USERS_JSON
    TASKS_JSON=$(fetch_tasks 2>/dev/null || echo '{"tasks":[]}')
    USERS_JSON=$(fetch_users 2>/dev/null || echo '{"users":[]}')

    # Parse counts
    local TOTAL PENDING PROCESSING DONE FAILED USER_COUNT
    TOTAL=$(echo "$TASKS_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('tasks',[])))" 2>/dev/null || echo 0)
    PENDING=$(echo "$TASKS_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len([t for t in d.get('tasks',[]) if t.get('status')=='pending']))" 2>/dev/null || echo 0)
    PROCESSING=$(echo "$TASKS_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len([t for t in d.get('tasks',[]) if t.get('status')=='processing']))" 2>/dev/null || echo 0)
    DONE=$(echo "$TASKS_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len([t for t in d.get('tasks',[]) if t.get('status')=='done']))" 2>/dev/null || echo 0)
    FAILED=$(echo "$TASKS_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len([t for t in d.get('tasks',[]) if t.get('status')=='failed']))" 2>/dev/null || echo 0)
    USER_COUNT=$(echo "$USERS_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('users',[])))" 2>/dev/null || echo 0)

    echo ""
    echo -e "  ${C_BOLD}📊 概览${C_RESET}"
    echo -e "  ${C_DIM}用户${C_RESET}  ${C_BOLD}$USER_COUNT${C_RESET} 人注册"
    echo -e "  ${C_DIM}任务${C_RESET}  ${C_BOLD}$TOTAL${C_RESET} 总 | ${C_YELLOW}$PENDING 待处理${C_RESET} | ${C_BLUE}$PROCESSING 处理中${C_RESET} | ${C_GREEN}$DONE 完成${C_RESET} | ${C_RED}$FAILED 失败${C_RESET}"
    echo ""

    # Show pending tasks detail
    if [ "$PENDING" -gt 0 ] 2>/dev/null; then
        echo -e "  ${C_BOLD}${C_YELLOW}📋 待处理队列${C_RESET}"
        echo "$TASKS_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
tasks = [t for t in d.get('tasks',[]) if t.get('status')=='pending']
for t in tasks[:10]:
    size_mb = round((t.get('file_size',0) or 0) / 1024 / 1024, 1)
    print(f\"  #{t['id']} | {t.get('username','?'):12s} | {t.get('original_filename','?'):30s} | {size_mb} MB\")
" 2>/dev/null
        echo ""
    fi

    # Show processing tasks
    if [ "$PROCESSING" -gt 0 ] 2>/dev/null; then
        echo -e "  ${C_BOLD}${C_BLUE}⚙️  处理中${C_RESET}"
        echo "$TASKS_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
tasks = [t for t in d.get('tasks',[]) if t.get('status')=='processing']
for t in tasks[:5]:
    print(f\"  #{t['id']} | {t.get('username','?'):12s} | {t.get('original_filename','?')}\")
" 2>/dev/null
        echo ""
    fi

    # Show recent done tasks
    echo -e "  ${C_BOLD}${C_GREEN}✓ 最近完成${C_RESET}"
    echo "$TASKS_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
tasks = [t for t in d.get('tasks',[]) if t.get('status')=='done']
tasks.sort(key=lambda t: t.get('updated_at',''), reverse=True)
for t in tasks[:5]:
    size_mb = round((t.get('file_size',0) or 0) / 1024 / 1024, 1)
    print(f\"  #{t['id']} | {t.get('username','?'):12s} | {t.get('original_filename','?'):30s} | {size_mb} MB\")
if not tasks:
    print('  (无)')
" 2>/dev/null
    echo ""

    # Local processing status
    local LOCAL_PID
    LOCAL_PID=$(pgrep -f "run-video-cases.js" 2>/dev/null | head -1 || echo "")
    if [ -n "$LOCAL_PID" ]; then
        echo -e "  ${C_BOLD}${C_MAGENTA}🖥️  本地处理中 (PID: $LOCAL_PID)${C_RESET}"
        local PROC_CMD
        PROC_CMD=$(ps -p "$LOCAL_PID" -o args= 2>/dev/null | head -1)
        echo -e "  ${C_DIM}$PROC_CMD${C_RESET}"
        # Show latest log line
        local LATEST_LOG
        LATEST_LOG=$(ls -t "$PROJECT_ROOT"/tmp/sync/*.log 2>/dev/null | head -1)
        if [ -n "$LATEST_LOG" ]; then
            echo -e "  ${C_DIM}$(tail -1 "$LATEST_LOG" 2>/dev/null)${C_RESET}"
        fi
    else
        echo -e "  ${C_DIM}🖥️  本地: 空闲${C_RESET}"
    fi

    echo ""
    echo -e "${C_DIM}────────────────────────────────────────────────────${C_RESET}"

    if [ "$AUTO_PROCESS" = "--process" ] && [ "$PENDING" -gt 0 ] 2>/dev/null; then
        echo -e "  ${C_YELLOW}→ 发现 $PENDING 条待处理任务,开始同步处理...${C_RESET}"
        echo ""
        "$SCRIPT_DIR/sync-and-process.sh"
    else
        if [ "$PENDING" -gt 0 ] 2>/dev/null; then
            echo -e "  ${C_YELLOW}提示: $PENDING 条任务等待处理。加 --process 自动处理${C_RESET}"
        fi
        echo -e "  ${C_DIM}Ctrl+C 退出 | --process 自动处理 | --process --loop 持续轮询${C_RESET}"
    fi
}

# ─── Main ───
if [ "$LOOP_MODE" = "--loop" ] || [ "$AUTO_PROCESS" = "--loop" ]; then
    echo -e "${C_BOLD}持续监控模式${C_RESET} — 每 ${INTERVAL}s 刷新 (Ctrl+C 停止)"
    while true; do
        render_dashboard
        sleep "$INTERVAL"
    done
else
    render_dashboard
fi
