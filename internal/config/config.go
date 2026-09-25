package config

import (
	"time"
)

// ChannelDef defines the static profile of a radio channel including repeater coordinates.
type ChannelDef struct {
	ID         int     `json:"id"`
	Name       string  `json:"name"`
	Frequency  float64 `json:"frequency"`   // MHz (e.g. 446.00625)
	CTCSS      float64 `json:"ctcss"`       // CTCSS sub-tone (Hz)
	Color      string  `json:"color"`       // UI display color
	Latitude   float64 `json:"latitude"`    // Repeater Latitude
	Longitude  float64 `json:"longitude"`   // Repeater Longitude
	CoverageKm float64 `json:"coverage_km"` // Approximate coverage radius (km)
	Region     string  `json:"region"`      // Geographic area / sector
	IsPrivate  bool    `json:"is_private"`
	Password   string  `json:"password,omitempty"`
}

// Config holds all server configuration settings.
type Config struct {
	HTTPPort        int
	UDPPort         int
	TOTDuration     time.Duration // Time-Out-Timer for PTT floor
	MaxClients      int
	PingInterval    time.Duration
	PongWait        time.Duration
	WriteWait       time.Duration
	DefaultChannels []ChannelDef
}

// DefaultConfig returns the standard production defaults.
func DefaultConfig() *Config {
	return &Config{
		HTTPPort:     8080,
		UDPPort:      5005,
		TOTDuration:  60 * time.Second,
		MaxClients:   1000,
		PingInterval: 30 * time.Second,
		PongWait:     60 * time.Second,
		WriteWait:    10 * time.Second,
		DefaultChannels: []ChannelDef{
			{ID: 1, Name: "CH 01 - CENTRAL DISPATCH", Frequency: 446.00625, CTCSS: 67.0, Color: "#e74c3c", Latitude: 11.5564, Longitude: 104.9282, CoverageKm: 15.0, Region: "Central / Wat Phnom"},
			{ID: 2, Name: "CH 02 - NORTH SECTOR", Frequency: 446.01875, CTCSS: 88.5, Color: "#3498db", Latitude: 11.5850, Longitude: 104.8980, CoverageKm: 12.0, Region: "North / Toul Kork"},
			{ID: 3, Name: "CH 03 - SOUTH SECTOR", Frequency: 446.03125, CTCSS: 103.5, Color: "#2ecc71", Latitude: 11.5300, Longitude: 104.9250, CoverageKm: 12.0, Region: "South / Chamkarmon"},
			{ID: 4, Name: "CH 04 - OPERATIONS / WEST", Frequency: 446.04375, CTCSS: 118.8, Color: "#f39c12", Latitude: 11.5466, Longitude: 104.8441, CoverageKm: 20.0, Region: "West / Airport"},
			{ID: 5, Name: "CH 05 - SECURITY / EAST", Frequency: 446.05625, CTCSS: 131.8, Color: "#9b59b6", Latitude: 11.5720, Longitude: 104.9450, CoverageKm: 10.0, Region: "East / Chroy Changvar"},
			{ID: 6, Name: "CH 06 - CONVOY / LOGISTICS", Frequency: 446.06875, CTCSS: 156.7, Color: "#1abc9c", Latitude: 11.5000, Longitude: 104.8700, CoverageKm: 25.0, Region: "Southwest / Highway"},
			{ID: 7, Name: "CH 07 - MEDICAL / RESCUE", Frequency: 446.08125, CTCSS: 173.8, Color: "#e67e22", Latitude: 11.5650, Longitude: 104.9190, CoverageKm: 10.0, Region: "Calmette / Hospital Zone"},
			{ID: 8, Name: "CH 08 - EMERGENCY CALL", Frequency: 446.09375, CTCSS: 250.3, Color: "#e84118", Latitude: 11.5583, Longitude: 104.9121, CoverageKm: 50.0, Region: "Citywide Emergency"},
		},
	}
}
