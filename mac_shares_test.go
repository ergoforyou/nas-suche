//go:build !windows

package main

import "testing"

func TestSplitSMB(t *testing.T) {
	cases := []struct{ in, url, sub string }{
		{"smb://DiskStation/Daten", "smb://DiskStation/Daten", ""},
		{"smb://jens@192.168.1.10/Daten/Kunden/2026", "smb://192.168.1.10/Daten", "Kunden/2026"},
		{`\\DiskStation\Büro Daten\Eingang`, "smb://DiskStation/B%C3%BCro%20Daten", "Eingang"},
		{"smb://DiskStation/B%C3%BCro%20Daten/", "smb://DiskStation/B%C3%BCro%20Daten", ""},
		{"DiskStation", "smb://DiskStation", ""},
	}
	for _, c := range cases {
		u, sub := splitSMB(c.in)
		if u != c.url || sub != c.sub {
			t.Errorf("%q → %q %q, erwartet %q %q", c.in, u, sub, c.url, c.sub)
		}
	}
	if shareName("smb://DiskStation/B%C3%BCro%20Daten") != "Büro Daten" {
		t.Error("shareName")
	}
	if g := mountLine.FindStringSubmatch("//jens@DiskStation._smb._tcp.local/B%C3%BCro%20Daten on /Volumes/Büro Daten (smbfs, nodev, nosuid, mounted by jens)"); g == nil || g[3] != "/Volumes/Büro Daten" || unescape(g[2]) != "Büro Daten" {
		t.Errorf("mount: %v", g)
	}
}
