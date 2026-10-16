//go:build !windows

package main

import "os"

// Ohne Windows (nur zum Entwickeln/Testen der Browser-Oberfläche): schlanker Dienst ohne Fenster.
func main() {
	if isNativeHostCall(os.Args[1:]) {
		runNativeHost()
		return
	}
	writeExtension()
	registerNativeHost()
	runBackground()
}
