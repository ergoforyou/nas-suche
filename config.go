package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

const appName = "NasSuche"

type Config struct {
	Folders      []string `json:"ordner"`
	Excludes     []string `json:"ausschluesse"`
	RefreshHours int      `json:"aktualisieren_alle_stunden"`
	Workers      int      `json:"parallele_zugriffe"`
	InPath       bool     `json:"im_pfad_suchen"`
}

func defaultConfig() *Config {
	return &Config{
		Excludes: []string{"#recycle", "@eaDir", "#snapshot", "@Recycle", "$RECYCLE.BIN",
			"System Volume Information", ".DS_Store", "Thumbs.db", "desktop.ini"},
		RefreshHours: 12,
		Workers:      16,
	}
}

func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}

// userConfigPath: persönliche Einstellungen (%APPDATA%\NasSuche\einstellungen.json).
func userConfigPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = exeDir()
	}
	return filepath.Join(dir, appName, "einstellungen.json")
}

// sharedConfigPath: optionale Vorgabe neben der EXE (z. B. auf dem NAS für alle Kollegen).
func sharedConfigPath() string {
	return filepath.Join(exeDir(), "NasSuche.json")
}

func indexPath() string {
	dir, err := os.UserCacheDir() // %LOCALAPPDATA%
	if err != nil {
		dir = exeDir()
	}
	return filepath.Join(dir, appName, "index.dat")
}

func readConfig(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	c := defaultConfig()
	if err := json.Unmarshal(b, c); err != nil {
		return nil, err
	}
	if c.Workers < 1 {
		c.Workers = 16
	}
	return c, nil
}

// LoadConfig: erst persönliche Einstellungen, sonst Vorgabe neben der EXE, sonst Standard.
func LoadConfig() *Config {
	if c, err := readConfig(userConfigPath()); err == nil {
		return c
	}
	if c, err := readConfig(sharedConfigPath()); err == nil {
		return c
	}
	return defaultConfig()
}

func (c *Config) Save() error {
	p := userConfigPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(p, b, 0o644)
}
