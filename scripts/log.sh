#!/bin/bash

# --- 可配置区域 ---
# 你的应用包名 (tauri.conf.json 中的 identifier)
PACKAGE_NAME="com.ecaptureq.gojue"
# 你的 Rust 库名 (src-tauri/Cargo.toml 中的 name, 带下划线的那个)
CRATE_NAME="ecaptureq_lib"
# ------------------

echo "正在查找应用 '$PACKAGE_NAME' 的进程ID (PID)..."

# 获取应用的 PID
PID=$(adb shell pidof -s $PACKAGE_NAME)

# 检查是否找到了 PID
if [ -z "$PID" ]; then
    echo "错误：应用未运行或未找到。请确保应用正在前台或后台运行。"
    exit 1
fi

echo "成功找到 PID: $PID。开始监听日志..."
echo "只显示来自 'println!' (RustStdoutStderr) 和 'log::*' ($CRATE_NAME) 的日志。"
echo "按 Ctrl + C 停止。"
echo "----------------------------------------------------------------"

# 清空旧日志
adb logcat -c

# 运行 logcat 并通过 grep 进行过滤
# -E 参数表示使用扩展正则表达式，'|' 表示“或”
adb logcat --pid=$PID | grep -E "RustStdoutStderr|$CRATE_NAME"
