// Painel no celular: lê data/estado.json do repositório privado e dispara a
// ação "Monitor de manutenção" para dar baixa ou trocar o locatário.
// Fala direto com a API do GitHub.

const SERVICOS = { oleo: 'Troca de óleo', revisao: 'Revisão', pneu: 'Troca de pneu' };
const WORKFLOW = 'monitor.yml';
const $ = (id) => document.getElementById(id);

const guardar = {
  ler() { try { return JSON.parse(localStorage.getItem('painelMotos') || '{}'); } catch { return {}; } },
  salvar(v) { try { localStorage.setItem('painelMotos', JSON.stringify(v)); } catch {} },
};
let cfg = guardar.ler();
let ultimoEstado = null;
let ultimaConfig = null;

const km = (v) => (Math.round(v * 10) / 10).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' km';
const quando = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTel = (t) => {
  const d = String(t || '').replace(/\D/g, '').replace(/^55/, '');
  return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : t;
};

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
    ultimoEstado = estado;
    ultimaConfig = config;
    desenhar(estado, config);
    $('barraAcoes').hidden = false;
  } catch (e) {
    $('sub').textContent = '';
    mostrarMsg('Não consegui carregar: ' + esc(e.message), true);
  }
}

// 0 ok · 1 prestes a vencer · 2 vencido (mesma regra do robô)
const nivelDo = (rodado, limite, antecedencia = 0) =>
  rodado >= limite ? 2 : antecedencia > 0 && rodado >= limite - antecedencia ? 1 : 0;

// Serviços vencidos ou prestes a vencer: [{ srv, rodado, limite, faltam, nivel }]
function pendentesDe(m, limites, antecedencia) {
  if (m?.odometro == null) return [];
  return Object.entries(limites)
    .map(([srv, limite]) => ({ srv, limite, base: m.servicos?.[srv]?.base }))
    .filter((x) => x.base != null)
    .map((x) => {
      const rodado = Math.max(0, m.odometro - x.base);
      return { ...x, rodado, faltam: x.limite - rodado, nivel: nivelDo(rodado, x.limite, antecedencia[x.srv]) };
    })
    .filter((x) => x.nivel > 0);
}

// Mesmo texto que o robô manda para o locatário (vem do config.json).
function textoParaLocatario(placa, m, config, modo) {
  const textos = config.mensagensLocatario || {};
  const modelo = config.modelos?.[placa] || config.modeloPadrao || 'moto';
  const pend = pendentesDe(m, config.intervalos[modo], config.antecedenciaKm?.[modo] || {});
  const temRevisao = pend.some((p) => p.srv === 'revisao');
  return pend
    .filter((p) => !(p.srv === 'oleo' && temRevisao && config.revisaoIncluiOleo))
    .map((p) => {
      const f = Math.round(p.faltam);
      const situacao = f > 0 ? `está prestes a vencer — faltam ${km(f)}` : `já venceu — passou ${km(-f)} do limite`;
      const base = textos[p.srv] || `Olá! ${SERVICOS[p.srv]} da moto {modelo} (placa {placa}) {situacao}.`;
      return base.replace(/\{(\w+)\}/g, (t, k) => ({ placa, modelo, limite: km(p.limite), situacao }[k] ?? t));
    })
    .join('\n\n');
}

function blocoLocatario(placa, m, config, modo) {
  const loc = m.locatario;
  if (!loc?.telefone) {
    return `<div class="servico"><div class="linha"><span class="nome">👤 Locatário</span>
      <button class="leve" data-acao="locatario" data-placa="${esc(placa)}">Cadastrar</button></div>
      <div class="num">Nenhum cadastrado</div></div>`;
  }
  const texto = textoParaLocatario(placa, m, config, modo);
  const venc = texto.length > 0;
  const zap = `https://wa.me/${loc.telefone.replace(/\D/g, '')}?text=${encodeURIComponent(texto)}`;
  return `<div class="servico"><div class="linha"><span class="nome">👤 ${esc(loc.nome || 'Locatário')}</span>
      <button class="leve" data-acao="locatario" data-placa="${esc(placa)}">Trocar</button></div>
    <div class="num">${esc(fmtTel(loc.telefone))} · ${loc.apikey ? 'recebe aviso automático' : 'sem aviso automático'} · desde ${quando(loc.desde)}</div>
    ${venc ? `<a class="botao-zap" href="${zap}" target="_blank" rel="noopener">Avisar ${esc((loc.nome || 'locatário').split(' ')[0])} pelo WhatsApp</a>` : ''}
  </div>`;
}

function desenhar(estado, config) {
  const modo = estado.modo || config.modo;
  $('selo').hidden = modo !== 'teste';
  $('sub').textContent = `Última verificação: ${quando(estado.atualizadoEm)}`;
  const limites = config.intervalos[modo];
  const antecedencia = config.antecedenciaKm?.[modo] || {};
  const avisos = [];
  if (estado.falhaGeral) avisos.push(`⚠️ Última leitura do iTrack falhou: ${esc(estado.falhaGeral.erro)}`);
  if (!estado.motos) avisos.push('Ainda não houve nenhuma verificação. Toque em <b>Verificar agora</b>.');
  mostrarMsg(avisos.join('<br>'));

  const placas = [...new Set([...(estado.placas || []), ...config.placas])];
  $('lista').innerHTML = placas.map((placa) => {
    const m = estado.motos?.[placa] || { servicos: {} };
    const servicos = Object.keys(limites).map((srv) => {
      const s = m.servicos?.[srv];
      const limite = limites[srv];
      if (!s || s.base == null || m.odometro == null) {
        return `<div class="servico"><div class="linha"><span class="nome">${SERVICOS[srv]}</span><span class="num">aguardando leitura</span></div></div>`;
      }
      const rodado = Math.max(0, m.odometro - s.base);
      const pct = Math.min(100, (rodado / limite) * 100);
      const classe = ['', 's-atencao', 's-vencido'][nivelDo(rodado, limite, antecedencia[srv])];
      const falta = limite - rodado;
      return `<div class="servico ${classe}">
        <div class="linha"><span class="nome">${SERVICOS[srv]}</span>
          <button data-acao="baixa" data-placa="${esc(placa)}" data-srv="${srv}">Dar baixa</button></div>
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
      ${blocoLocatario(placa, m, config, modo)}
      ${servicos}
      <div class="servico"><button class="leve" data-acao="baixa" data-placa="${esc(placa)}" data-srv="todos">Dar baixa em tudo desta moto</button></div>
    </article>`;
  }).join('');
}

// Dispara o robô no GitHub com os dados do pedido e espera terminar.
async function disparar(inputs, textoEspera, textoOk) {
  const botoes = document.querySelectorAll('button');
  botoes.forEach((b) => (b.disabled = true));
  const inicio = new Date(Date.now() - 5000).toISOString();
  let resultado = [textoOk, false];
  try {
    await api(`/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref: cfg.ramo || 'main', inputs }),
    });
    mostrarMsg(`${textoEspera} Aguardando o robô (≈1 min)…`);
    await esperarExecucao(inicio);
  } catch (e) {
    resultado = [esc(e.message), true];
  }
  botoes.forEach((b) => (b.disabled = false));
  await carregar();
  mostrarMsg(...resultado); // depois de recarregar, para a mensagem não sumir
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

// Folhas que sobem de baixo (a caixa confirm() do navegador é bloqueada
// em alguns celulares quando o site está instalado como app).
function abrirFolha(id, botoes) {
  return new Promise((resolver) => {
    const fundo = $(id);
    fundo.hidden = false;
    const fechar = (resposta) => {
      fundo.hidden = true;
      for (const b of Object.keys(botoes)) $(b).onclick = null;
      fundo.onclick = null;
      resolver(resposta);
    };
    for (const [b, resposta] of Object.entries(botoes)) $(b).onclick = () => fechar(resposta);
    fundo.onclick = (ev) => { if (ev.target === fundo) fechar(null); };
  });
}

function perguntar(titulo, texto) {
  $('confTitulo').textContent = titulo;
  $('confTexto').textContent = texto;
  return abrirFolha('confirmar', { confSim: true, confNao: false });
}

async function editarLocatario(placa) {
  const loc = ultimoEstado?.motos?.[placa]?.locatario;
  $('locTitulo').textContent = `Locatário da ${placa}`;
  $('locNome').value = loc?.nome || '';
  $('locTel').value = loc?.telefone ? fmtTel(loc.telefone) : '';
  $('locApikey').value = loc?.apikey || '';
  $('locRemover').hidden = !loc?.telefone;
  const r = await abrirFolha('folhaLocatario', { locSalvar: 'salvar', locRemover: 'remover', locCancelar: null });
  if (r === 'remover') {
    disparar({ acao: 'locatario', placa, nome: '', telefone: '', apikey: '' }, `Removendo locatário da ${esc(placa)}.`, '✅ Locatário removido.');
  } else if (r === 'salvar') {
    const telefone = $('locTel').value.replace(/\D/g, '');
    if (telefone.length < 10) return mostrarMsg('Celular inválido: use DDD + número, ex.: 27 99999-1234.', true);
    disparar(
      { acao: 'locatario', placa, nome: $('locNome').value.trim(), telefone, apikey: $('locApikey').value.trim() },
      `Salvando locatário da ${esc(placa)}.`,
      '✅ Locatário salvo.' + ($('locApikey').value.trim() ? ' Ele deve receber uma mensagem de boas-vindas.' : ''),
    );
  }
}

$('btnConfig').onclick = () => ($('telaConfig').hidden ? abrirConfig() : ($('telaConfig').hidden = true));
$('btnSalvar').onclick = () => {
  cfg = { ...cfg, dono: $('cDono').value.trim(), repo: $('cRepo').value.trim(), token: $('cToken').value.trim() };
  guardar.salvar(cfg);
  $('telaConfig').hidden = true;
  carregar();
};
$('btnAtualizar').onclick = carregar;
$('btnVerificar').onclick = () => disparar({ acao: '' }, 'Verificação pedida.', '✅ Verificação concluída.');
$('lista').onclick = async (ev) => {
  const b = ev.target.closest('button[data-acao]');
  if (!b || b.disabled) return;
  const { acao, placa, srv } = b.dataset;
  if (acao === 'locatario') return editarLocatario(placa);
  const nome = srv === 'todos' ? 'todos os serviços' : SERVICOS[srv];
  const ok = await perguntar(`Dar baixa: ${nome}`, `Moto ${placa}. O odômetro atual vira a nova base e a contagem recomeça do zero.`);
  if (ok) disparar({ acao: 'baixa', placa, servico: srv }, `Baixa enviada para ${esc(placa)}.`, '✅ Baixa registrada.');
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
carregar();
