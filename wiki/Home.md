# KyuubiSoft Hytale Panel - Wiki

Willkommen zur offiziellen Wiki des **KyuubiSoft Hytale Panels** - einem vollautomatischen Docker-Setup mit Web Admin Panel für Hytale Dedicated Server.

<p align="center">
  <img src="https://img.shields.io/badge/Version-2.0.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/Security_Rating-9%2F10-green" alt="Security Rating">
  <img src="https://img.shields.io/badge/Status-Production_Ready-success" alt="Status">
</p>

---

## Schnellnavigation

| Kategorie | Beschreibung |
|-----------|--------------|
| [[Installation]] | Installations- und Setup-Anleitung |
| [[Konfiguration]] | Alle Umgebungsvariablen und Einstellungen |
| [[Features]] | Übersicht aller Panel-Funktionen |
| [[API-Dokumentation]] | Vollständige REST API Referenz |
| [[Sicherheit]] | Sicherheitsfeatures und Best Practices |
| [[Benutzerverwaltung]] | Rollen, Berechtigungen und Benutzer |
| [[Fehlerbehebung]] | Häufige Probleme und Lösungen |
| [[Changelog]] | Versionshistorie und Updates |
| [[Server-Befehle]] | Hytale Server Befehlsreferenz |

---

## Was ist das KyuubiSoft Hytale Panel?

Das **KyuubiSoft Hytale Panel** ist eine vollumfängliche, produktionsreife Web-basierte Administrations- und Managementplattform für Hytale Dedicated Server.

### Hauptmerkmale

- **Vollautomatisches Docker-Setup** - Einfache Bereitstellung mit Docker Compose
- **Modernes Web-Interface** - Dark Theme UI mit Echtzeit-Updates
- **Live Konsole** - Echtzeit-Logs mit Filterung und Auto-Scroll
- **Spielerverwaltung** - Kick, Ban, Teleport, Gamemode und mehr
- **Backup-System** - Automatische und manuelle Backups mit Wiederherstellung
- **Scheduler** - Geplante Backups und automatische Neustarts
- **Mod & Plugin Support** - Upload, Aktivieren/Deaktivieren, Config Editor
- **Multi-User System** - Mehrere Benutzer mit rollenbasierter Zugriffskontrolle
- **60+ Berechtigungen** - Granulares Berechtigungssystem
- **Mehrsprachig** - Deutsch, Englisch, Portugiesisch

---

## Technologie-Stack

### Frontend
- **Vue.js 3** - Progressive JavaScript Framework
- **Vite** - Modernes Build-Tool
- **Tailwind CSS** - Utility-First CSS Framework
- **Pinia** - State Management
- **XTerm.js** - Terminal Emulator

### Backend
- **Node.js 20** - JavaScript Runtime
- **Express.js 4** - Web Framework
- **TypeScript 5** - Typisiertes JavaScript
- **WebSocket** - Echtzeit-Kommunikation
- **Dockerode** - Docker API Client

### Infrastruktur
- **Docker & Docker Compose** - Containerisierung
- **Alpine Linux** - Minimale Base Images
- **Eclipse Temurin JDK 25** - Java Runtime

---

## Schnellstart

### Voraussetzungen

- Docker und Docker Compose installiert
- Mindestens 4GB RAM empfohlen
- UDP Port 5520 erreichbar (QUIC Protokoll)
- Web Panel Port 18080 erreichbar

### Schnellinstallation

```bash
# Repository klonen
git clone https://github.com/KyuubiDDragon/KyuubiSoft-Hytale-Panel
cd KyuubiSoft-Hytale-Panel

# .env Datei erstellen
cp .env.example .env

# Secrets generieren und .env bearbeiten
JWT_SECRET=$(openssl rand -base64 48)
echo "JWT_SECRET=$JWT_SECRET" >> .env

# Container starten
docker-compose up -d
```

Für detaillierte Installationsanweisungen siehe [[Installation]].

---

## Support & Community

- **Ko-fi**: [https://ko-fi.com/kyuubiddragon](https://ko-fi.com/kyuubiddragon) - Unterstütze das Projekt
- **Discord**: [https://dsc.gg/kyuubisoft](https://dsc.gg/kyuubisoft) - Community Support
- **GitHub Issues**: [GitHub Repository](https://github.com/KyuubiDDragon/KyuubiSoft-Hytale-Panel/issues)

---

## Lizenz

Dieses Projekt ist unter der **GPL-3.0 Lizenz** lizenziert. Siehe [LICENSE](https://github.com/KyuubiDDragon/KyuubiSoft-Hytale-Panel/blob/main/LICENSE) für Details.

---

**Erstellt mit von KyuubiDDragon (KyuubiSoft)**
