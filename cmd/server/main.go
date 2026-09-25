package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"

	"twowayradio/internal/config"
	"twowayradio/internal/radio"
	"twowayradio/internal/roip"
	"twowayradio/internal/web"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:    1024 * 32,
	WriteBufferSize:   1024 * 32,
	EnableCompression: false, // Explicitly disable compression to eliminate buffering and compression latency
	CheckOrigin: func(r *http.Request) bool {
		// Allow all origins for seamless LAN / mobile phone access
		return true
	},
}

func generateID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func main() {
	cfg := config.DefaultConfig()

	portFlag := flag.Int("port", cfg.HTTPPort, "HTTP and WebSocket server port")
	udpFlag := flag.Int("udp", cfg.UDPPort, "RoIP UDP listener port (0 to disable)")
	totFlag := flag.Int("tot", int(cfg.TOTDuration.Seconds()), "Push-to-Talk Time-Out-Timer in seconds")
	flag.Parse()

	cfg.HTTPPort = *portFlag
	cfg.UDPPort = *udpFlag
	cfg.TOTDuration = time.Duration(*totFlag) * time.Second

	log.Println("==================================================")
	log.Println("   TWO-WAY RADIO / WALKIE-TALKIE SERVER (Go)    ")
	log.Println("==================================================")
	log.Printf("HTTP / Web GUI Port : %d", cfg.HTTPPort)
	log.Printf("RoIP UDP Port       : %d", cfg.UDPPort)
	log.Printf("PTT Time-Out-Timer  : %v", cfg.TOTDuration)
	log.Printf("Channels Configured : %d", len(cfg.DefaultChannels))

	// Initialize radio hub
	hub := radio.NewHub(cfg)

	// Initialize optional RoIP UDP Server
	var udpServer *roip.UDPServer
	if cfg.UDPPort > 0 {
		udpServer = roip.NewUDPServer(cfg.UDPPort, hub)
		if err := udpServer.Start(); err != nil {
			log.Printf("[Warning] RoIP UDP listener failed to start: %v", err)
		}
	}

	mux := http.NewServeMux()

	// WebSocket handler
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("[WebSocket] Upgrade error: %v", err)
			return
		}

		// Optimize TCP socket for ultra-low latency:
		// 1. Disable Nagle's algorithm (TCP_NODELAY) so packets flush immediately
		// 2. Set keep-alive to maintain healthy persistent channel
		if tcpConn, ok := conn.UnderlyingConn().(*net.TCPConn); ok {
			_ = tcpConn.SetNoDelay(true)
			_ = tcpConn.SetKeepAlive(true)
			_ = tcpConn.SetKeepAlivePeriod(15 * time.Second)
			_ = tcpConn.SetWriteBuffer(32 * 1024)
			_ = tcpConn.SetReadBuffer(32 * 1024)
		}

		id := generateID()
		callsign := r.URL.Query().Get("callsign")
		if callsign == "" {
			callsign = fmt.Sprintf("UNIT-%s", id)
		}

		client := radio.NewClient(id, callsign, hub, conn)
		hub.RegisterClient(client)

		go client.WritePump()
		go client.ReadPump()
	})

	// REST API: Channels List
	mux.HandleFunc("/api/channels", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(hub.GetChannelList())
	})

	// REST API: Server Status / Metrics
	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(hub.GetStatus())
	})

	// Ensure uploads directory exists
	uploadDir := "./data/uploads"
	_ = os.MkdirAll(uploadDir, 0755)

	// REST API: File Upload
	mux.HandleFunc("/api/upload", func(w http.ResponseWriter, r *http.Request) {
		// CORS headers for seamless tunnel access
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// 32MB max memory
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			http.Error(w, "File too large: "+err.Error(), http.StatusBadRequest)
			return
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			http.Error(w, "Failed to read file: "+err.Error(), http.StatusBadRequest)
			return
		}
		defer file.Close()

		ext := filepath.Ext(header.Filename)
		cleanExt := strings.ToLower(ext)
		uniqueID := fmt.Sprintf("%d_%s", time.Now().UnixNano(), generateID())
		savedName := fmt.Sprintf("%s%s", uniqueID, cleanExt)
		dstPath := filepath.Join(uploadDir, savedName)

		dst, err := os.Create(dstPath)
		if err != nil {
			http.Error(w, "Failed to save file: "+err.Error(), http.StatusInternalServerError)
			return
		}
		defer dst.Close()

		if _, err := io.Copy(dst, file); err != nil {
			http.Error(w, "Failed to write file: "+err.Error(), http.StatusInternalServerError)
			return
		}

		fileURL := fmt.Sprintf("/uploads/%s", savedName)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"url":  fileURL,
			"name": header.Filename,
			"size": header.Size,
			"type": header.Header.Get("Content-Type"),
		})
	})

	// Serve uploaded files
	mux.Handle("/uploads/", http.StripPrefix("/uploads/", http.FileServer(http.Dir(uploadDir))))

	// Embedded Web UI
	fileServer := http.FileServer(web.GetFileSystem())
	mux.Handle("/", fileServer)

	server := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.HTTPPort),
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

	// Graceful shutdown handling
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	go func() {
		log.Printf("Radio Server ready! Open http://localhost:%d in your browser.", cfg.HTTPPort)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server failed: %v", err)
		}
	}()

	<-stop
	log.Println("\nShutting down Two-Way Radio server...")

	if udpServer != nil {
		udpServer.Stop()
	}

	log.Println("Server stopped cleanly.")
}
