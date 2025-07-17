package main

import (
	"encoding/base64"
	"encoding/json"
	"log"
	"math/rand"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// PacketData 结构体与您 Rust 项目中的 core::models::PacketData 完全对应。
// 我们使用 `json:"..."` 标签来确保生成的 JSON 字段名与前端期望的一致。
type PacketData struct {
	Timestamp     int64  `json:"timestamp"`
	SrcIP         string `json:"src_ip"`
	SrcPort       uint32 `json:"src_port"`
	DstIP         string `json:"dst_ip"`
	DstPort       uint32 `json:"dst_port"`
	PID           int32  `json:"pid"`
	PName         string `json:"pname"`
	Type          string `json:"type"` // 对应 Rust 的 `r#type`
	Length        uint32 `json:"length"`
	PayloadBase64 string `json:"payload_base64"`
}

// upgrader 将普通的 HTTP 连接升级为 WebSocket 连接。
var upgrader = websocket.Upgrader{
	// CheckOrigin 允许来自任何源的连接，用于本地开发。
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// 模拟数据池，让生成的数据看起来更真实一些。
var (
	sampleIPs    = []string{"192.168.1.10", "10.0.0.5", "172.16.3.41", "223.5.5.5"}
	sampleDstIPs = []string{"8.8.8.8", "114.114.114.114", "202.96.128.86", "52.84.124.23"}
	samplePNames = []string{"Chrome", "WeChat", "QQMusic", "sshd", "nginx"}
	packetTypes  = []string{"Request", "Response"}
)

// generateMockPacket 创建一个随机的模拟数据包。
func generateMockPacket(r *rand.Rand) PacketData {
	payload := make([]byte, r.Intn(256)+32) // 32 to 288 bytes payload
	r.Read(payload)

	return PacketData{
		Timestamp:     time.Now().UnixNano(),
		SrcIP:         sampleIPs[r.Intn(len(sampleIPs))],
		SrcPort:       uint32(r.Intn(50000) + 1024),
		DstIP:         sampleDstIPs[r.Intn(len(sampleDstIPs))],
		DstPort:       uint32(r.Intn(1000) + 1),
		PID:           int32(r.Intn(30000) + 1000),
		PName:         samplePNames[r.Intn(len(samplePNames))],
		Type:          packetTypes[r.Intn(len(packetTypes))],
		Length:        uint32(len(payload)),
		PayloadBase64: base64.StdEncoding.EncodeToString(payload),
	}
}

// handleConnection 是每个 WebSocket 连接的核心处理函数。
// 它会为一个客户端持续地、不规则地发送数据。
func handleConnection(conn *websocket.Conn) {
	log.Printf("客户端 %s 已连接", conn.RemoteAddr())
	defer func() {
		log.Printf("客户端 %s 已断开连接", conn.RemoteAddr())
		conn.Close()
	}()

	// 为每个 goroutine 创建一个独立的随机数源，避免并发问题
	r := rand.New(rand.NewSource(time.Now().UnixNano()))

	for {
		// --- 突发阶段 (Burst) ---
		// 模拟短时间内产生大量数据包的情况
		burstCount := r.Intn(40) + 10 // 随机发送 10 到 50 个包
		log.Printf("[%s] 进入突发模式，将发送 %d 个数据包...", conn.RemoteAddr(), burstCount)
		for i := 0; i < burstCount; i++ {
			packet := generateMockPacket(r)
			jsonData, _ := json.Marshal(packet)

			if err := conn.WriteMessage(websocket.TextMessage, jsonData); err != nil {
				// 如果写入失败（例如客户端关闭了连接），就退出循环
				return
			}
			// 在突发阶段，包之间的间隔非常短
			time.Sleep(time.Duration(r.Intn(40)+10) * time.Millisecond) // 10-50ms 的随机延迟
		}

		// --- 平静阶段 (Lull) ---
		// 模拟网络空闲时期
		lullDuration := time.Duration(r.Intn(4000)+1000) * time.Millisecond // 1-5秒的随机延迟
		log.Printf("[%s] 进入平静模式，将等待 %.2f 秒...", conn.RemoteAddr(), lullDuration.Seconds())
		time.Sleep(lullDuration)
	}
}

func main() {
	// 设置 WebSocket 的路由
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Println("升级 WebSocket 失败:", err)
			return
		}
		// 为每一个新的连接创建一个新的 goroutine 来独立处理
		go handleConnection(conn)
	})

	// 设置一个 WaitGroup 来等待所有服务优雅地关闭
	var wg sync.WaitGroup
	wg.Add(1)

	// 在一个 goroutine 中启动 HTTP 服务器，这样它就不会阻塞主线程
	go func() {
		defer wg.Done()
		port := "18088"
		log.Printf("WebSocket 模拟服务器已启动，正在监听端口: %s", port)
		log.Printf("请将您的 Tauri 应用连接到 ws://127.0.0.1:%s/ws", port)
		if err := http.ListenAndServe(":"+port, nil); err != nil && err != http.ErrServerClosed {
			log.Fatalf("启动服务器失败: %v", err)
		}
	}()

	// 设置一个 channel 来监听操作系统的中断信号 (Ctrl+C)
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	// 阻塞主线程，直到收到关闭信号
	<-quit
	log.Println("收到关闭信号，服务器正在关闭...")

	// 这里可以添加更复杂的关闭逻辑，但对于此模拟器，直接退出即可。
	// wg.Wait() // 如果有需要等待的任务，可以在这里等待
}
