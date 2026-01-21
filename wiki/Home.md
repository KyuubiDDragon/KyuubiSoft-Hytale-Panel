# KyuubiSoft Hytale Panel

Welcome to the official documentation for the **KyuubiSoft Hytale Panel** - a production-ready web-based administration panel for Hytale dedicated servers.

<p align="center">
  <img src="https://img.shields.io/badge/Version-2.0.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/Security_Rating-9%2F10-green" alt="Security Rating">
  <img src="https://img.shields.io/badge/Status-Production_Ready-success" alt="Status">
</p>

---

## Quick Navigation

| Category | Description |
|----------|-------------|
| [[Installation]] | Installation and setup guide |
| [[Configuration]] | All environment variables and settings |
| [[Features]] | Overview of all panel features |
| [[API-Documentation]] | Complete REST API reference |
| [[Security]] | Security features and best practices |
| [[User-Management]] | Roles, permissions and users |
| [[Troubleshooting]] | Common issues and solutions |
| [[Changelog]] | Version history and updates |
| [[Server-Commands]] | Hytale server command reference |

---

## What is the KyuubiSoft Hytale Panel?

The **KyuubiSoft Hytale Panel** is a comprehensive, production-ready web-based administration and management platform for Hytale Dedicated Servers.

### Key Features

- **Fully Automated Docker Setup** - Easy deployment with Docker Compose
- **Modern Web Interface** - Dark theme UI with real-time updates
- **Live Console** - Real-time logs with filtering and auto-scroll
- **Player Management** - Kick, ban, teleport, gamemode and more
- **Backup System** - Automatic and manual backups with restore
- **Scheduler** - Scheduled backups and automatic restarts
- **Mod & Plugin Support** - Upload, enable/disable, config editor
- **Multi-User System** - Multiple users with role-based access control
- **60+ Permissions** - Granular permission system
- **Multi-Language** - German, English, Portuguese

---

## Technology Stack

### Frontend
- **Vue.js 3** - Progressive JavaScript Framework
- **Vite** - Modern Build Tool
- **Tailwind CSS** - Utility-First CSS Framework
- **Pinia** - State Management
- **XTerm.js** - Terminal Emulator

### Backend
- **Node.js 20** - JavaScript Runtime
- **Express.js 4** - Web Framework
- **TypeScript 5** - Typed JavaScript
- **WebSocket** - Real-time Communication
- **Dockerode** - Docker API Client

### Infrastructure
- **Docker & Docker Compose** - Containerization
- **Alpine Linux** - Minimal Base Images
- **Eclipse Temurin JDK 25** - Java Runtime

---

## Quick Start

### Prerequisites

- Docker and Docker Compose installed
- Minimum 4GB RAM recommended
- UDP Port 5520 accessible (QUIC protocol)
- Web Panel Port 18080 accessible

### Quick Installation

```bash
# Clone repository
git clone https://github.com/KyuubiDDragon/KyuubiSoft-Hytale-Panel
cd KyuubiSoft-Hytale-Panel

# Create .env file
cp .env.example .env

# Generate secrets and edit .env
JWT_SECRET=$(openssl rand -base64 48)
echo "JWT_SECRET=$JWT_SECRET" >> .env

# Start containers
docker-compose up -d
```

For detailed installation instructions see [[Installation]].

---

## Support & Community

- **Ko-fi**: [https://ko-fi.com/kyuubiddragon](https://ko-fi.com/kyuubiddragon) - Support the project
- **Discord**: [https://dsc.gg/kyuubisoft](https://dsc.gg/kyuubisoft) - Community Support
- **GitHub Issues**: [GitHub Repository](https://github.com/KyuubiDDragon/KyuubiSoft-Hytale-Panel/issues)

---

## License

This project is licensed under the **GPL-3.0 License**. See [LICENSE](https://github.com/KyuubiDDragon/KyuubiSoft-Hytale-Panel/blob/main/LICENSE) for details.

---

**Created with love by KyuubiDDragon (KyuubiSoft)**
