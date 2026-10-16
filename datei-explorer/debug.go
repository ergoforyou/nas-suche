//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// dbg schreibt nur, wenn die Umgebungsvariable DATEIEXPLORER_LOG gesetzt ist (Fehlersuche).
func dbg(format string, args ...interface{}) {
	if os.Getenv("DATEIEXPLORER_LOG") == "" {
		return
	}
	f, err := os.OpenFile(filepath.Join(os.TempDir(), "dateiexplorer.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s "+format+"\n", append([]interface{}{time.Now().Format("15:04:05.000")}, args...)...)
}
