# ============================================================
# Hytale Server - Makefile
# ============================================================

.PHONY: help build start stop restart logs console backup status update clean

help:
	@echo "Hytale Server - Docker Commands"
	@echo ""
	@echo "  make build    - Docker-Image bauen"
	@echo "  make start    - Server starten"
	@echo "  make stop     - Server stoppen"
	@echo "  make restart  - Server neustarten"
	@echo "  make logs     - Logs anzeigen"
	@echo "  make console  - Server-Console öffnen"
	@echo "  make backup   - Manuelles Backup erstellen"
	@echo "  make status   - Server-Status anzeigen"
	@echo "  make update   - Update-Helper starten"
	@echo "  make clean    - Docker-Cleanup"

build:
	docker-compose build

start:
	docker-compose up -d

stop:
	docker-compose down

restart:
	docker-compose restart

logs:
	docker-compose logs -f

console:
	@echo "Console öffnen... Zum Verlassen: Ctrl+P, dann Ctrl+Q"
	docker attach hytale-server

backup:
	docker exec hytale-server /opt/hytale/backup.sh

status:
	docker-compose ps
	@echo ""
	@docker stats --no-stream hytale-server 2>/dev/null || echo "Server nicht gestartet"

update:
	./update.sh

clean:
	docker-compose down --rmi local -v
	docker system prune -f
