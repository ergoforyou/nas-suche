package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

const appName = "NasSuche"

type Config struct {
	Folders      []string `json:"ordner"`
	Excludes     []string `json:"ausschluesse"`
	RefreshHours int      `json:"aktualisieren_alle_stunden"`
	Workers      int      `json:"parallele_zugriffe"`
	InPath       bool     `json:"im_pfad_suchen"`

	Drives         []DriveMap `json:"netzlaufwerke"`
	SharedIndexDir string     `json:"gemeinsamer_index_ordner"`
	SharedWriter   bool       `json:"gemeinsamen_index_erstellen"`
	Hotkey         string     `json:"tastenkombination"`
	CopyTargets    []string   `json:"kopierziele"`
	TrayHintShown  bool       `json:"hinweis_hintergrund_gezeigt"`
	Filter         int        `json:"schnellfilter"` // 0 Alle, 1 PDF, 2 Bilder, 3 Office, 4 Ordner
}

// DriveMap: Netzlaufwerk, das beim Programmstart verbunden wird.
type DriveMap struct {
	Letter string `json:"laufwerk"` // "Z:" oder leer
	Remote string `json:"pfad"`     // \\DiskStation\Daten
}

func (d DriveMap) String() string {
	if d.Letter == "" {
		return d.Remote
	}
	return d.Letter + "   →   " + d.Remote
}

const sharedIndexName = "NasSuche-Index.dat"

func (c *Config) sharedIndexPath() string {
	if c.SharedIndexDir == "" {
		return ""
	}
	return filepath.Join(c.SharedIndexDir, sharedIndexName)
}

// sharedReader: Index kommt vom NAS, dieser PC liest selbst nicht ein.
func (c *Config) sharedReader() bool { return c.SharedIndexDir != "" && !c.SharedWriter }

func (c *Config) addCopyTarget(dir string) {
	out := []string{dir}
	for _, t := range c.CopyTargets {
		if !strings.EqualFold(t, dir) && len(out) < 8 {
			out = append(out, t)
		}
	}
	c.CopyTargets = out
}

func defaultConfig() *Config {
	return &Config{
		Excludes: []string{"#recycle", "@eaDir", "#snapshot", "@Recycle", "$RECYCLE.BIN",
			"System Volume Information", ".DS_Store", "Thumbs.db", "desktop.ini"},
		RefreshHours: 4,
		Workers:      16,
		Hotkey:       "Strg+Alt+Leertaste",
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
	if c.Hotkey == "" {
		c.Hotkey = "Strg+Alt+Leertaste"
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
