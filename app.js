// Painel no celular: lê data/estado.json do repositório privado e dispara a
// ação "Monitor de manutenção" para dar baixa. Fala direto com a API do GitHub.

const SERVICOS = { oleo: 'Troca de óleo', revisao: 'Revisão', pneu: 'Troca de pneu' };
const WORKFLOW = 'monitor.yml';
const $ = (id) => document.getElementById(id);

const guardar = {
  ler() { try { return JSON.parse(localStorage.getItem('painelMotos') || '{}'); } catch { return {}; } },
  salvar(v) { try { localStorage.setItem('painelMotos', JSON.stringify(v)); } catch {} },
};
let cfg = guardar.ler();

const km = (v) => (Math.round(v * 10) / 10).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' km';
const quando = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function mostrarMsg(texto, erro = false) {
  $('msg').innerHTML = texto ? `<div class="aviso ${erro ? 'erro' : ''}">${texto}</div>` : '';
}

async function api(caminho, opcoes = {}) {
  const r = await fetch(`https://api.github.com/repos/${cfg.dono}/${cfg.repo}${caminho}`, {
    ...opcoes,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: opcoes.accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opcoes.body && { 'Content-Type': 'application/json' }),
    },
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(r.status === 401 ? 'Token inválido ou vencido.' : r.status === 404 ? 'Repositório não encontrado (confira usuário, nome e permissões do token).' : `GitHub ${r.status}: ${t.slice(0, 120)}`);
  }
  return r.status === 204 ? null : r.json();
}

const lerArquivo = (caminho) => api(`/contents/${caminho}?t=${Date.now()}`, { accept: 'application/vnd.github.raw+json' });

async function carregar() {
  if (!cfg.dono || !cfg.token) return abrirConfig();
  $('sub').textContent = 'Carregando…';
  try {
    const [estado, config] = await Promise.all([lerArquivo('data/estado.json'), lerArquivo('config.json')]);
    desenhar(estado, config);
    $('barraAcoes').hidden = false;
  } catch (e) {
    $('sub').textContent = '';
    mostrarMsg('Não consegui carregar: ' + esc(e.message), true);
  }
}

function desenhar(estado, config) {
  const modo = estado.modo || config.modo;
  $('selo').hidden = modo !== 'teste';
  $('sub').textContent = `Última verificação: ${quando(estado.atualizadoEm)}`;
  const limites = config.intervalos[modo];
  const avisos = [];
  if (estado.falhaGeral) avisos.push(`⚠️ Última leitura do iTrack falhou: ${esc(estado.falhaGeral.erro)}`);
  if (!estado.motos) avisos.push('Ainda não houve nenhuma verificação. Toque em <b>Verificar agora</b>.');
  if (avisos.length) mostrarMsg(avisos.join('<br>'));

  $('lista').innerHTML = config.placas.map((placa) => {
    const m = estado.motos?.[placa] || { servicos: {} };
    const servicos = Object.keys(limites).map((srv) => {
      const s = m.servicos?.[srv];
      const limite = limites[srv];
      if (!s || s.base == null || m.odometro == null) {
        return `<div class="servico"><div class="linha"><span class="nome">${SERVICOS[srv]}</span><span class="num">aguardando leitura</span></div></div>`;
      }
      const rodado = Math.max(0, m.odometro - s.base);
      const pct = Math.min(100, (rodado / limite) * 100);
      const classe = rodado >= limite ? 's-vencido' : pct >= 80 ? 's-atencao' : '';
      const falta = limite - rodado;
      return `<div class="servico ${classe}">
        <div class="linha"><span class="nome">${SERVICOS[srv]}</span>
          <button data-placa="${esc(placa)}" data-srv="${srv}">Dar baixa</button></div>
        <div class="barra"><i style="width:${pct.toFixed(1)}%"></i></div>
        <div class="num">${km(rodado)} de ${km(limite)} · ${falta > 0 ? 'faltam ' + km(falta) : 'passou ' + km(-falta)}<br>
          última em ${km(s.base)} (${quando(s.baseEm)})</div>
      </div>`;
    }).join('');
    const semSinal = m.semSinal ? `<div class="alerta">📡 Sem enviar posição desde ${quando(m.ultimaPosicao)}</div>` : '';
    const erro = m.erroLeitura ? `<div class="alerta">⚠️ ${esc(m.erroLeitura)}</div>` : '';
    return `<article class="cartao">
      <div class="topo"><span class="placa">${esc(placa)}</span><span class="odo">${m.odometro != null ? km(m.odometro) : '—'}</span></div>
      <div class="info">Última posição: ${quando(m.ultimaPosicao)}</div>${semSinal}${erro}
      ${servicos}
      <div class="servico"><button class="leve" data-placa="${esc(placa)}" data-srv="todos">Dar baixa em tudo desta moto</button></div>
    </article>`;
  }).join('');
}

async function disparar(placa = '', servico = '') {
  const botoes = document.querySelectorAll('button');
  botoes.forEach((b) => (b.disabled = true));
  const inicio = new Date(Date.now() - 5000).toISOString();
  try {
    await api(`/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref: cfg.ramo || 'main', inputs: { placa, servico } }),
    });
    mostrarMsg(placa ? `Baixa enviada para ${esc(placa)}. Aguardando o robô (≈1 min)…` : 'Verificação pedida. Aguardando o robô (≈1 min)…');
    await esperarExecucao(inicio);
    mostrarMsg(placa ? '✅ Baixa registrada.' : '✅ Verificação concluída.');
  } catch (e) {
    mostrarMsg(esc(e.message), true);
  } finally {
    botoes.forEach((b) => (b.disabled = false));
    carregar();
  }
}

async function esperarExecucao(desde) {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 8000));
    const { workflow_runs: runs } = await api(`/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=1&created=${encodeURIComponent('>=' + desde)}`);
    const run = runs?.[0];
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') throw new Error('O robô terminou com erro. Veja a aba Actions no GitHub.');
      return;
    }
  }
  throw new Error('Demorou mais que o normal. Toque em Atualizar daqui a pouco.');
}

function abrirConfig() {
  $('telaConfig').hidden = false;
  $('cDono').value = cfg.dono || '';
  $('cRepo').value = cfg.repo || 'moto-manutencao';
  $('cToken').value = cfg.token || '';
  $('sub').textContent = '';
}

$('btnConfig').onclick = () => ($('telaConfig').hidden ? abrirConfig() : ($('telaConfig').hidden = true));
$('btnSalvar').onclick = () => {
  cfg = { ...cfg, dono: $('cDono').value.trim(), repo: $('cRepo').value.trim(), token: $('cToken').value.trim() };
  guardar.salvar(cfg);
  $('telaConfig').hidden = true;
  carregar();
};
$('btnAtualizar').onclick = carregar;
$('btnVerificar').onclick = () => disparar();
// Confirmação desenhada no próprio painel (a caixa confirm() do navegador
// é bloqueada em alguns celulares quando o site está instalado como app).
function perguntar(titulo, texto) {
  return new Promise((resolver) => {
    $('confTitulo').textContent = titulo;
    $('confTexto').textContent = texto;
    $('confirmar').hidden = false;
    const fechar = (resposta) => {
      $('confirmar').hidden = true;
      $('confSim').onclick = $('confNao').onclick = $('confirmar').onclick = null;
      resolver(resposta);
    };
    $('confSim').onclick = () => fechar(true);
    $('confNao').onclick = () => fechar(false);
    $('confirmar').onclick = (ev) => { if (ev.target === $('confirmar')) fechar(false); };
  });
}

$('lista').onclick = async (ev) => {
  const b = ev.target.closest('button[data-placa]');
  if (!b || b.disabled) return;
  const { placa, srv } = b.dataset;
  const nome = srv === 'todos' ? 'todos os serviços' : SERVICOS[srv];
  const ok = await perguntar(`Dar baixa: ${nome}`, `Moto ${placa}. O odômetro atual vira a nova base e a contagem recomeça do zero.`);
  if (ok) disparar(placa, srv);
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
carregar();
