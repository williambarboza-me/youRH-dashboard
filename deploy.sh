#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy do Painel de Performance YouRH
#
# Uso:   ./deploy.sh "mensagem do que voce mudou"
#        ./deploy.sh                (usa uma mensagem padrao)
#
# O script se posiciona sozinho na pasta certa, entao pode ser chamado de
# qualquer lugar. Ele tambem NAO para no meio quando nao ha nada novo para
# commitar -- esse era o caso em que o push silenciosamente nao acontecia.
# ─────────────────────────────────────────────────────────────────────────────

# Vai para a pasta onde este arquivo esta, seja qual for o diretorio atual.
cd "$(dirname "$0")" || { echo "Nao consegui entrar na pasta do projeto."; exit 1; }

MENSAGEM="${1:-atualizacao do painel}"
VERSAO=$(grep -o 'v1\.[0-9]*\.[0-9]*' public/dashboard.html 2>/dev/null | head -1)

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Deploy do Painel YouRH ${VERSAO}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Locks orfaos de um git que travou antes. Nomes explicitos em vez de *.lock
# porque no zsh um * que nao encontra nada aborta o comando inteiro.
rm -f .git/index.lock .git/HEAD.lock 2>/dev/null

git add -A

# --cached --quiet retorna 0 quando NAO ha nada preparado para commit.
if git diff --cached --quiet; then
  echo "• Nenhum arquivo novo alterado."
else
  if git commit -m "$MENSAGEM" > /dev/null 2>&1; then
    echo "• Commit criado: $MENSAGEM"
  else
    echo "❌ O commit falhou. Rode 'git status' para ver o motivo."
    exit 1
  fi
fi

# Quantos commits existem aqui que ainda nao estao no GitHub.
PENDENTES=$(git rev-list --count origin/main..main 2>/dev/null || echo "?")

if [ "$PENDENTES" = "0" ]; then
  echo ""
  echo "✅ Tudo ja esta no ar. Nada novo para enviar."
  echo "   Se o painel nao mudou, de Cmd+Shift+R no navegador."
  echo ""
  exit 0
fi

echo "• Enviando ${PENDENTES} commit(s) para o GitHub..."
echo ""

if git push origin main > /tmp/yourh_push.log 2>&1; then
  HASH=$(git log --oneline -1 | cut -d' ' -f1)
  echo "✅ SUBIU!"
  echo ""
  echo "   Commit:  $HASH"
  echo "   Versao:  ${VERSAO}"
  echo ""
  echo "   O Railway faz o deploy automatico em cerca de 2 minutos."
  echo "   Depois disso, de Cmd+Shift+R no painel para ver as mudancas."
  echo ""
else
  echo "❌ O envio falhou. Motivo:"
  echo ""
  sed 's/^/   /' /tmp/yourh_push.log
  echo ""
  if grep -qi "rejected\|non-fast-forward\|behind" /tmp/yourh_push.log; then
    echo "   → Alguem alterou o repositorio antes de voce."
    echo "     Rode:  git pull origin main   e depois ./deploy.sh de novo."
  elif grep -qi "403\|authentication\|denied\|could not read Username" /tmp/yourh_push.log; then
    echo "   → Problema no token de acesso do GitHub."
    echo "     O token pode ter expirado. Gere um novo e rode:"
    echo "     git remote set-url origin https://SEU_TOKEN@github.com/williambarboza-me/youRH-dashboard.git"
  else
    echo "   → Copie o texto acima e me mande que eu resolvo."
  fi
  echo ""
  exit 1
fi
