/**
 * YouRH Dashboard — Servidor Railway
 * Node.js + Express | JWT Auth | Google Sheets API | 3 papéis de acesso
 */

const express      = require('express');
const jwt          = require('jsonwebtoken');
const bcrypt       = require('bcryptjs');
const cookieParser = require('cookie-parser');
const { google }   = require('googleapis');
const fs           = require('fs');
const path         = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const JWT_SECRET      = process.env.JWT_SECRET;
const SPREADSHEET_ID  = process.env.SPREADSHEET_ID || '1kjwjwQF8KL2ijEt9jB-UkWYLmLTZ5XuF6k44sAFzAgU';
const SHEET_NAME      = process.env.SHEET_NAME || 'Sheet1';
const USERS_SHEET     = 'Usuarios';   // aba de gestão de usuários na planilha
const CACHE_TTL_MS    = 5 * 60 * 1000;

if (!JWT_SECRET) {
  console.error('❌  Variável JWT_SECRET não definida. Configure-a no Railway antes de iniciar.');
  process.exit(1);
}

// ─── USUÁRIOS ─────────────────────────────────────────────────────────────────
// Carregado do env var inicialmente; substituído pela planilha no startup
let USERS = [];
try {
  USERS = JSON.parse(process.env.USERS || '[]');
} catch (e) {
  console.error('❌  Erro ao ler USERS. Verifique o formato JSON na variável de ambiente.');
  process.exit(1);
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cookieParser());

// ─── GOOGLE SHEETS HELPER ─────────────────────────────────────────────────────
function getSheets() {
  let credentials;
  try {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON inválido ou não definido');
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    // Scope de leitura+escrita para suportar gestão de usuários
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ─── CACHE DADOS DE PERFORMANCE ───────────────────────────────────────────────
let sheetsCache = { data: null, ts: 0 };

async function getRawData() {
  const now = Date.now();
  if (sheetsCache.data && now - sheetsCache.ts < CACHE_TTL_MS) {
    return sheetsCache.data;
  }

  const sheets = getSheets();
  const resp   = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_NAME,
  });

  const rows = resp.data.values || [];
  if (rows.length < 2) return [];

  const headerIdx = rows.findIndex(r => r && r.length >= 3);
  if (headerIdx === -1) return [];

  const normalize = s => {
    const lower = s.toLowerCase().trim();
    return lower.normalize('NFD').split('').filter(c => {
      const code = c.charCodeAt(0);
      return code < 0x0300 || code > 0x036F;
    }).join('');
  };

  const headers = rows[headerIdx].map(normalize);

  const fieldMap = h => {
    if (h === 'mes' || h === 'mês' || h.startsWith('mê') || (h.startsWith('me') && h.length <= 4)) return 'mes';
    if (h === 'nome' || h === 'colaborador' || h === 'name') return 'nome';
    if (h === 'setor' || h === 'sector' || h === 'departamento' || h === 'area' || h === 'área') return 'setor';
    if (h === '%' || h === 'perc' || h === 'performance' || h === 'produtividade' || h.includes('%') || h.includes('prod') || h.includes('perf')) return 'perc';
    return h;
  };

  const parsed = rows.slice(headerIdx + 1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[fieldMap(h)] = (row[i] || '').trim(); });
    const percStr = (obj.perc || '0').replace('%', '').replace(',', '.');
    const perc = parseFloat(percStr);
    if (!obj.nome || !obj.mes || isNaN(perc)) return null;
    return { mes: obj.mes, nome: obj.nome, setor: obj.setor || '', perc };
  }).filter(Boolean);

  sheetsCache = { data: parsed, ts: now };
  return parsed;
}

// ─── GESTÃO DE USUÁRIOS VIA GOOGLE SHEETS ────────────────────────────────────

/**
 * Garante que a aba "Usuarios" existe na planilha.
 * Cria a aba com headers se não existir.
 */
async function ensureUsersSheet(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === USERS_SHEET);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: USERS_SHEET } } }],
      },
    });
    // Escreve headers
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${USERS_SHEET}!A1:E1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['email', 'nome', 'role', 'setor', 'password']] },
    });
    console.log(`✅  Aba "${USERS_SHEET}" criada na planilha.`);
  }
}

/**
 * Carrega usuários da aba "Usuarios" da planilha.
 * Retorna array de usuários (com hash de senha) ou null se falhar.
 */
async function loadUsersFromSheets() {
  const sheets = getSheets();
  await ensureUsersSheet(sheets);

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${USERS_SHEET}!A:E`,
  });
  const rows = (resp.data.values || []).slice(1); // pula header
  return rows
    .filter(r => r && r[0] && r[2]) // email e role obrigatórios
    .map(r => ({
      email:    (r[0] || '').trim(),
      nome:     (r[1] || '').trim(),
      role:     (r[2] || '').trim(),
      setor:    (r[3] || '').trim() || null,
      password: (r[4] || '').trim(),
    }))
    .filter(u => u.email && u.password);
}

/**
 * Salva um novo usuário na planilha (linha nova no final).
 */
async function saveUserToSheet(user) {
  const sheets = getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${USERS_SHEET}!A:E`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[user.email, user.nome, user.role, user.setor || '', user.password]],
    },
  });
}

/**
 * Remove um usuário da planilha pelo e-mail.
 */
async function deleteUserFromSheet(email) {
  const sheets = getSheets();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${USERS_SHEET}!A:A`,
  });
  const rows = resp.data.values || [];
  const rowIndex = rows.findIndex((r, i) => i > 0 && r[0] && r[0].toLowerCase() === email.toLowerCase());
  if (rowIndex === -1) throw new Error('Usuário não encontrado na planilha');

  // Busca o sheetId da aba Usuarios
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === USERS_SHEET);
  if (!sheet) throw new Error('Aba Usuarios não encontrada');
  const sheetId = sheet.properties.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex,
            endIndex: rowIndex + 1,
          },
        },
      }],
    },
  });
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.redirect('/login');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie('token');
    res.redirect('/login');
  }
}

function requireAuthAPI(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token expirado ou inválido' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'rh_admin') return res.status(403).json({ error: 'Acesso restrito ao Admin RH' });
  next();
}

// ─── FILTRAGEM POR PAPEL ──────────────────────────────────────────────────────
function filterByRole(data, user) {
  switch (user.role) {
    case 'rh_admin':
    case 'direcao':    return data;
    case 'gestor':     return data.filter(d => d.setor === user.setor);
    case 'colaborador':return data.filter(d => d.nome === user.nome);
    case 'lider': {
      // Lider vê dados completos da(s) sua(s) área(s); demais setores chegam
      // anonimizados (nome='__agg__') para permitir comparações agregadas.
      const setores = (user.setor || '').split(',').map(s => s.trim()).filter(Boolean);
      return data.map(d =>
        setores.includes(d.setor) ? d : { mes: d.mes, setor: d.setor, perc: d.perc, nome: '__agg__' }
      );
    }
    default:           return [];
  }
}

// ─── ROTAS DE AUTENTICAÇÃO ────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  const token = req.cookies.token;
  if (token) {
    try { jwt.verify(token, JWT_SECRET); return res.redirect('/'); } catch {}
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'E-mail e senha são obrigatórios' });

  const user = USERS.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Senha incorreta' });

  const payload = { email: user.email, nome: user.nome, role: user.role, setor: user.setor || null };
  const token   = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });

  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000,
  });

  res.json({ ok: true, nome: user.nome, role: user.role });
});

app.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// ─── API DE DADOS ─────────────────────────────────────────────────────────────
app.get('/api/me', requireAuthAPI, (req, res) => {
  res.json(req.user);
});

app.get('/api/data', requireAuthAPI, async (req, res) => {
  try {
    const all      = await getRawData();
    const filtered = filterByRole(all, req.user);
    res.json(filtered);
  } catch (err) {
    console.error('Erro Sheets:', err.message);
    res.status(500).json({ error: 'Não foi possível buscar os dados da planilha' });
  }
});

app.post('/api/refresh', requireAuthAPI, (req, res) => {
  if (req.user.role !== 'rh_admin') return res.status(403).json({ error: 'Acesso negado' });
  sheetsCache = { data: null, ts: 0 };
  res.json({ ok: true, message: 'Cache limpo' });
});

// ─── ADMIN: GESTÃO DE USUÁRIOS ────────────────────────────────────────────────

// GET /api/admin/users — lista usuários sem senhas
app.get('/api/admin/users', requireAuthAPI, requireAdmin, (req, res) => {
  const safe = USERS.map(u => ({
    email: u.email, nome: u.nome, role: u.role, setor: u.setor || null,
  }));
  res.json(safe);
});

// POST /api/admin/users — cria novo usuário
app.post('/api/admin/users', requireAuthAPI, requireAdmin, async (req, res) => {
  const { email, nome, role, setor, password } = req.body || {};
  if (!email || !nome || !role || !password) {
    return res.status(400).json({ error: 'Campos obrigatórios: email, nome, role, password' });
  }
  if (!['rh_admin', 'direcao', 'gestor', 'colaborador', 'lider'].includes(role)) {
    return res.status(400).json({ error: 'Role inválido. Use: rh_admin | direcao | gestor | colaborador | lider' });
  }
  if ((role === 'gestor' || role === 'lider') && !setor) {
    return res.status(400).json({ error: 'Gestor/Líder precisam de setor definido (use vírgula para múltiplos, ex: CS,Tech)' });
  }
  if (USERS.find(u => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: 'E-mail já cadastrado' });
  }

  try {
    const hash    = await bcrypt.hash(password, 10);
    const newUser = { email: email.toLowerCase(), nome, role, setor: setor || null, password: hash };
    await saveUserToSheet(newUser);
    USERS.push(newUser);
    console.log(`✅  Usuário criado: ${email} (${role})`);
    res.json({ ok: true, user: { email: newUser.email, nome: newUser.nome, role: newUser.role, setor: newUser.setor } });
  } catch (err) {
    console.error('Erro ao criar usuário:', err.message);
    res.status(500).json({ error: 'Erro ao salvar usuário na planilha. Verifique se a Service Account tem permissão de Editor na planilha.' });
  }
});

// DELETE /api/admin/users/:email — remove usuário
app.delete('/api/admin/users/:email', requireAuthAPI, requireAdmin, async (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  if (email === req.user.email.toLowerCase()) {
    return res.status(400).json({ error: 'Não é possível remover seu próprio usuário' });
  }
  const idx = USERS.findIndex(u => u.email.toLowerCase() === email);
  if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });

  try {
    await deleteUserFromSheet(email);
    USERS.splice(idx, 1);
    console.log(`🗑️  Usuário removido: ${email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao remover usuário:', err.message);
    res.status(500).json({ error: 'Erro ao remover usuário da planilha.' });
  }
});

// ─── DASHBOARD (server-side injection) ───────────────────────────────────────
const DASHBOARD_HTML = path.join(__dirname, 'public', 'dashboard.html');

app.get('/', requireAuth, async (req, res) => {
  try {
    const all      = await getRawData();
    const filtered = filterByRole(all, req.user);

    let html = fs.readFileSync(DASHBOARD_HTML, 'utf-8');
    const injection = `
<script>
  window.__YOURH_USER__ = ${JSON.stringify(req.user)};
  window.__YOURH_DATA__ = ${JSON.stringify(filtered)};
</script>`;
    html = html.replace('</head>', injection + '\n</head>');
    res.send(html);
  } catch (err) {
    console.error('Erro ao montar dashboard:', err.message);
    res.status(500).send('<h2>Erro ao carregar o painel. Tente novamente.</h2>');
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`✅  YouRH Dashboard rodando na porta ${PORT}`);
  console.log(`    Planilha: ${SPREADSHEET_ID} / aba: ${SHEET_NAME}`);

  // Carrega usuários da planilha Google Sheets (sobrescreve env var USERS)
  try {
    const usersFromSheets = await loadUsersFromSheets();
    if (usersFromSheets.length > 0) {
      USERS = usersFromSheets;
      console.log(`✅  Usuários carregados da planilha: ${USERS.length}`);
    } else {
      // Planilha existe mas está vazia — migra os usuários do env var para ela
      console.log('ℹ️   Planilha de usuários vazia. Migrando env var USERS para a planilha...');
      const envUsers = JSON.parse(process.env.USERS || '[]');
      for (const u of envUsers) {
        await saveUserToSheet(u).catch(e => console.warn('Aviso migração:', e.message));
      }
      if (envUsers.length > 0) console.log(`✅  ${envUsers.length} usuário(s) migrado(s) do env var para a planilha.`);
    }
  } catch (e) {
    console.warn('⚠️  Não foi possível carregar usuários da planilha:', e.message);
    console.warn('    Usando usuários do env var USERS como fallback.');
  }

  console.log(`    Usuários ativos: ${USERS.length}`);
});
