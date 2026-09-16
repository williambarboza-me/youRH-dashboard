#!/bin/bash
# Script para publicar o fix do parsing no Railway
# Execute: bash push-fix.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "📁 Diretório: $SCRIPT_DIR"

# Remove lock file se existir
rm -f .git/index.lock
echo "✅ Lock removido"

# Configura identidade git
git config user.email "william.b@yourh.com.br"
git config user.name "William Barboza"

# Commit e push
git add server.js public/dashboard.html
git commit -m "feat: papel lider com visao individual propria area + agregado das demais (v1.8.2)"
git push

echo ""
echo "✅ Push feito! Aguarde ~1 min e atualize o painel."
