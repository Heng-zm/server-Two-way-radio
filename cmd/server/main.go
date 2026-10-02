package main

import (
	"compress/gzip"
	"context"
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
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"

	"twowayradio/internal/config"
	"twowayradio/internal/radio"
	"twowayradio/internal/roip"
	"twowayradio/internal/web"
)

// Optimized WebSocket upgrader with small 4KB buffers for low-spec servers (VPS / Raspberry Pi)
var upgrader = websocket.Upgrader{
	ReadBufferSize:    4096,
	WriteBufferSize:   4096,
	EnableCompression: false, // Disabled to eliminate compression CPU overhead and audio latency
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

func generateID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func main() {
	// Runtime tuning for low-resource environments (VPS / Raspberry Pi / Containers)
	runtime.GOMAXPROCS(0) // Automatically respect container / VM CPU quotas
	if os.Getenv("GOGC") == "" {
		debug.SetGCPercent(75) // Keep heap size compact to prevent out-of-memory on 512MB/1GB VPS
	}
	if memLimit := os.Getenv("GOMEMLIMIT"); memLimit == "" {
		if memMB := os.Getenv("MEMORY_LIMIT_MB"); memMB != "" {
			if mb, err := strconv.ParseInt(memMB, 10, 64); err == nil && mb > 0 {
				debug.SetMemoryLimit(mb * 1024 * 1024)
			}
		}
	}

	cfg := config.DefaultConfig()

	portFlag := flag.Int("port", cfg.HTTPPort, "HTTP and WebSocket server port")
	udpFlag := flag.Int("udp", cfg.UDPPort, "RoIP UDP listener port (0 to disable)")
	totFlag := flag.Int("tot", int(cfg.TOTDuration.Seconds()), "Push-to-Talk Time-Out-Timer in seconds")
	flag.Parse()

	cfg.HTTPPort = *portFlag
	cfg.UDPPort = *udpFlag
	cfg.TOTDuration = time.Duration(*totFlag) * time.Second

	// Environment variable overrides (essential for Docker & Cloud Platforms)
	if envPort := os.Getenv("PORT"); envPort != "" {
		if p, err := strconv.Atoi(envPort); err == nil && p > 0 {
			cfg.HTTPPort = p
		}
	}
	if envUDP := os.Getenv("UDP_PORT"); envUDP != "" {
		if u, err := strconv.Atoi(envUDP); err == nil && u >= 0 {
			cfg.UDPPort = u
		}
	}
	if envTOT := os.Getenv("TOT_SECONDS"); envTOT != "" {
		if t, err := strconv.Atoi(envTOT); err == nil && t > 0 {
			cfg.TOTDuration = time.Duration(t) * time.Second
		}
	}

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
		hub.SetRoIPRelay(udpServer.BroadcastAudio)
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

		// Optimize TCP socket for ultra-low latency & small memory footprint:
		// 1. Disable Nagle's algorithm (TCP_NODELAY) so packets flush immediately
		// 2. Set keep-alive to maintain healthy persistent channel
		// 3. Compact 8KB TCP buffer sizes to support hundreds of concurrent users on small RAM
		if tcpConn, ok := conn.UnderlyingConn().(*net.TCPConn); ok {
			_ = tcpConn.SetNoDelay(true)
			_ = tcpConn.SetKeepAlive(true)
			_ = tcpConn.SetKeepAlivePeriod(15 * time.Second)
			_ = tcpConn.SetWriteBuffer(8 * 1024)
			_ = tcpConn.SetReadBuffer(8 * 1024)
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

	// REST API: Detailed Performance Metrics
	mux.HandleFunc("/api/metrics", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(hub.GetMetrics())
	})

	// REST API: Audio Archive Recordings
	mux.HandleFunc("/api/recordings", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		chID := 0
		if chParam := r.URL.Query().Get("channel_id"); chParam != "" {
			if id, err := strconv.Atoi(chParam); err == nil {
				chID = id
			}
		}
		_ = json.NewEncoder(w).Encode(hub.GetRecordings(chID))
	})

	// Healthcheck endpoints for Docker, Kubernetes, and Cloud Load Balancers
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"status": "healthy",
			"time":   time.Now().UTC().Format(time.RFC3339),
		})
	})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("OK"))
	})

	// Runtime Client Config
	mux.HandleFunc("/api/config", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"mapbox_token": os.Getenv("MAPBOX_TOKEN"),
		})
	})

	// Ensure uploads and recordings directories exist
	uploadDir := "./data/uploads"
	_ = os.MkdirAll(uploadDir, 0755)

	recordingsDir := "./data/recordings"
	_ = os.MkdirAll(recordingsDir, 0755)

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

		// Enforce strict 32MB request body ceiling to prevent disk exhaustion DoS
		const maxUploadSize = 32 << 20 // 32 MB
		r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)

		if err := r.ParseMultipartForm(maxUploadSize); err != nil {
			http.Error(w, "File exceeds maximum permitted size (32MB)", http.StatusBadRequest)
			return
		}

		file, header, err := r.FormFile("file")
		if err != nil {
			http.Error(w, "Failed to read file: "+err.Error(), http.StatusBadRequest)
			return
		}
		defer file.Close()

		ext := strings.ToLower(filepath.Ext(header.Filename))
		allowedExts := map[string]bool{
			// Images
			".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true,
			// Audio
			".mp3": true, ".ogg": true, ".wav": true, ".m4a": true, ".aac": true, ".flac": true,
			// Video
			".mp4": true, ".webm": true,
			// Documents & Archives
			".pdf": true, ".txt": true, ".zip": true, ".doc": true, ".docx": true, ".xls": true, ".xlsx": true, ".csv": true,
		}

		if !allowedExts[ext] {
			http.Error(w, "File type not permitted for security reasons", http.StatusBadRequest)
			return
		}

		uniqueID := fmt.Sprintf("%d_%s", time.Now().UnixNano(), generateID())
		savedName := fmt.Sprintf("%s%s", uniqueID, ext)
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

	// Serve uploaded files with security headers
	uploadFS := http.StripPrefix("/uploads/", http.FileServer(http.Dir(uploadDir)))
	mux.HandleFunc("/uploads/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		uploadFS.ServeHTTP(w, r)
	})

	// Serve archived audio recordings with immutable browser caching
	recordingsFS := http.StripPrefix("/recordings/", http.FileServer(http.Dir(recordingsDir)))
	mux.HandleFunc("/recordings/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "public, max-age=604800, immutable")
		recordingsFS.ServeHTTP(w, r)
	})

	// Embedded Web UI with dynamic gzip compression and browser caching for small servers
	fileServer := http.FileServer(web.GetFileSystem())
	mux.HandleFunc("/", makeOptimizedStaticHandler(fileServer))

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
	log.Println("\nShutting down Two-Way Radio server gracefully...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("[Warning] HTTP server forced shutdown: %v", err)
	}

	if udpServer != nil {
		udpServer.Stop()
	}

	log.Println("Server stopped cleanly.")
}

// Gzip compression buffer pool to eliminate GC allocations during HTTP compression
var gzipPool = sync.Pool{
	New: func() interface{} {
		gz, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed)
		return gz
	},
}

type gzipResponseWriter struct {
	io.Writer
	http.ResponseWriter
}

func (w *gzipResponseWriter) Write(b []byte) (int, error) {
	return w.Writer.Write(b)
}

func (w *gzipResponseWriter) WriteHeader(code int) {
	w.Header().Del("Content-Length") // Content-Length changes under dynamic gzip
	w.ResponseWriter.WriteHeader(code)
}

// makeOptimizedStaticHandler wraps static file serving with gzip compression and browser caching.
// This reduces bandwidth consumption by ~75% and saves small server CPU cycles on asset delivery.
func makeOptimizedStaticHandler(fs http.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		// Cache policies:
		// - HTML files / root: no-cache, must-revalidate (ensures users always see latest code)
		// - Static assets (JS, CSS, SVG, PNG, WebP, Audio): public, 24h caching
		if path == "/" || strings.HasSuffix(path, ".html") {
			w.Header().Set("Cache-Control", "no-cache, must-revalidate")
		} else if strings.HasSuffix(path, ".js") || strings.HasSuffix(path, ".css") ||
			strings.HasSuffix(path, ".svg") || strings.HasSuffix(path, ".png") ||
			strings.HasSuffix(path, ".woff2") || strings.HasSuffix(path, ".wav") ||
			strings.HasSuffix(path, ".mp3") {
			w.Header().Set("Cache-Control", "public, max-age=86400, stale-while-revalidate=3600")
		}

		w.Header().Set("X-Content-Type-Options", "nosniff")

		// Transparent gzip compression for compressible text/web assets
		acceptsGzip := strings.Contains(r.Header.Get("Accept-Encoding"), "gzip")
		compressible := path == "/" || strings.HasSuffix(path, ".html") ||
			strings.HasSuffix(path, ".js") || strings.HasSuffix(path, ".css") ||
			strings.HasSuffix(path, ".svg") || strings.HasSuffix(path, ".json")

		if acceptsGzip && compressible {
			w.Header().Set("Content-Encoding", "gzip")
			w.Header().Set("Vary", "Accept-Encoding")
			gz := gzipPool.Get().(*gzip.Writer)
			gz.Reset(w)
			defer func() {
				_ = gz.Close()
				gzipPool.Put(gz)
			}()

			gzw := &gzipResponseWriter{Writer: gz, ResponseWriter: w}
			fs.ServeHTTP(gzw, r)
			return
		}

		fs.ServeHTTP(w, r)
	}
}
