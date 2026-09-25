package roip

import (
	"fmt"
	"log"
	"net"
	"sync"

	"twowayradio/internal/radio"
)

// UDPServer listens for raw UDP packets from RoIP gateways or hardware transceivers (ESP32/Raspberry Pi).
type UDPServer struct {
	port   int
	hub    *radio.Hub
	conn   *net.UDPConn
	stopCh chan struct{}
	mu     sync.Mutex
	peers  map[string]*net.UDPAddr
}

// NewUDPServer creates a new RoIP UDP listener.
func NewUDPServer(port int, hub *radio.Hub) *UDPServer {
	return &UDPServer{
		port:   port,
		hub:    hub,
		stopCh: make(chan struct{}),
		peers:  make(map[string]*net.UDPAddr),
	}
}

// Start begins listening on the UDP socket.
func (s *UDPServer) Start() error {
	addr := &net.UDPAddr{
		Port: s.port,
		IP:   net.ParseIP("0.0.0.0"),
	}

	conn, err := net.ListenUDP("udp", addr)
	if err != nil {
		return fmt.Errorf("failed to bind UDP port %d: %w", s.port, err)
	}
	s.conn = conn

	log.Printf("[RoIP] UDP Radio-over-IP server listening on :%d", s.port)

	go s.listenLoop()
	return nil
}

// Stop shuts down the UDP listener.
func (s *UDPServer) Stop() {
	close(s.stopCh)
	if s.conn != nil {
		s.conn.Close()
	}
}

func (s *UDPServer) listenLoop() {
	buf := make([]byte, 4096)

	for {
		select {
		case <-s.stopCh:
			return
		default:
		}

		n, remoteAddr, err := s.conn.ReadFromUDP(buf)
		if err != nil {
			select {
			case <-s.stopCh:
				return
			default:
				log.Printf("[RoIP] UDP read error: %v", err)
				continue
			}
		}

		if n < radio.AudioHeaderSize {
			continue
		}

		packet := make([]byte, n)
		copy(packet, buf[:n])

		// Remember peer
		s.mu.Lock()
		s.peers[remoteAddr.String()] = remoteAddr
		s.mu.Unlock()

		// Validate radio header
		hdr, _, err := radio.ParseAudioHeader(packet)
		if err != nil {
			continue
		}

		// When RoIP device transmits, relay into channel
		log.Printf("[RoIP] Received %d bytes UDP audio from %s for Ch %d (Seq: %d)", n, remoteAddr, hdr.ChannelID, hdr.SeqNum)
	}
}
