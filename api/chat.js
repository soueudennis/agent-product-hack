// Product Hack Agent — Vercel Serverless Proxy
// Runtime: Node.js (padrão Vercel)

const ATLASSIAN_BASE = 'https://virtuem.atlassian.net';
const CONFLUENCE_STRATEGY_PAGE_ID = '213745665';

function getAtlassianAuth() {
  const email = process.env.ATLASSIAN_EMAIL;
  const token = process.env.ATLASSIAN_TOKEN;
  if (!email || !token) return null;
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

async function fetchConfluenceStrategyPage(auth) {
  try {
    const res = await fetch(
      `${ATLASSIAN_BASE}/wiki/rest/api/content/${CONFLUENCE_STRATEGY_PAGE_ID}?expand=body.storage`,
      { headers: { Authorization: auth, Accept: 'application/json' }, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const html = data?.body?.storage?.value || '';
    // Remove HTML tags
    const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    return text.length > 100 ? text.substring(0, 3000) : null;
  } catch {
    return null;
  }
}

async function searchJiraIssues(auth, keywords, product) {
  try {
    const projectKey = product === 'Projuris ADV' ? 'ADV' : 'PJE';
    const cleanKw = keywords.replace(/"/g, '').substring(0, 60);
    const jql = `project = ${projectKey} AND text ~ "${cleanKw}" ORDER BY updated DESC`;
    const url = `${ATLASSIAN_BASE}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=6&fields=summary,status,issuetype,priority,description`;
    const res = await fetch(url, {
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.issues || []).map(issue => ({
      key: issue.key,
      summary: issue.fields?.summary || '',
      status: issue.fields?.status?.name || '',
      type: issue.fields?.issuetype?.name || '',
    }));
  } catch {
    return [];
  }
}

async function searchJiraCS(auth, keywords, product) {
  try {
    const projectKey = product === 'Projuris ADV' ? 'ADV' : 'PJE';
    const cleanKw = keywords.replace(/"/g, '').substring(0, 60);
    const jql = `project = ${projectKey} AND issuetype in ("Bug", "Support", "Reclamação") AND text ~ "${cleanKw}" ORDER BY updated DESC`;
    const url = `${ATLASSIAN_BASE}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=4&fields=summary,status,issuetype`;
    const res = await fetch(url, {
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.issues || []).map(issue => ({
      key: issue.key,
      summary: issue.fields?.summary || '',
      type: issue.fields?.issuetype?.name || '',
    }));
  } catch {
    return [];
  }
}

async function searchConfluenceDocs(auth, keywords) {
  try {
    const cleanKw = keywords.replace(/"/g, '').substring(0, 60);
    const cql = `space = "PROJInterno" AND text ~ "${cleanKw}" ORDER BY lastModified DESC`;
    const url = `${ATLASSIAN_BASE}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=4&expand=excerpt`;
    const res = await fetch(url, {
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map(p => ({
      title: p.title || '',
      excerpt: (p.excerpt || '').replace(/<[^>]+>/g, '').trim(),
      id: p.id,
    }));
  } catch {
    return [];
  }
}

function extractKeywords(text) {
  const stopWords = new Set(['para', 'como', 'isso', 'esse', 'esta', 'este', 'uma', 'que', 'por', 'com', 'não', 'mais', 'dos', 'das', 'nos', 'nas', 'são', 'tem', 'ter', 'ser', 'foi', 'há']);
  return text
    .toLowerCase()
    .replace(/[^\w\sáàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4 && !stopWords.has(w))
    .slice(0, 6)
    .join(' ');
}

function buildSystemPrompt(product, strategyPage, jiraIssues, jiraCS, confluenceDocs) {
  const hasAtlassian = !!(strategyPage || jiraIssues.length || jiraCS.length || confluenceDocs.length);

  let contextBlock = '';

  if (strategyPage) {
    contextBlock += `\n\n---\n## ESTRATÉGIA DE PRODUTO 2026 — Confluence\n${strategyPage}`;
  }

  if (jiraIssues.length > 0) {
    contextBlock += `\n\n---\n## ISSUES JIRA RELACIONADAS\n`;
    jiraIssues.forEach(i => {
      contextBlock += `- **${i.key}**: ${i.summary} [${i.status}] (${i.type})\n`;
    });
  }

  if (jiraCS.length > 0) {
    contextBlock += `\n\n---\n## TICKETS CS / BUGS RELACIONADOS\n`;
    jiraCS.forEach(i => {
      contextBlock += `- **${i.key}**: ${i.summary} (${i.type})\n`;
    });
  }

  if (confluenceDocs.length > 0) {
    contextBlock += `\n\n---\n## DOCUMENTOS CONFLUENCE ENCONTRADOS\n`;
    confluenceDocs.forEach(d => {
      contextBlock += `- **"${d.title}"**: ${d.excerpt}\n`;
    });
  }

  if (!hasAtlassian) {
    contextBlock = '\n\n⚠️ Conexão com Atlassian indisponível no momento. Baseie sua análise no contexto estratégico da UNLT e nas informações que a pessoa fornecer.';
  }

  return `Você é o **Product Hack Agent**, co-piloto do Build it Day da Projuris.
Produto ativo: **${product}**

---

## SEU PAPEL — COPILOTO, NÃO FORMULÁRIO

Você trabalha PARA a pessoa, não com ela através de perguntas. Ao receber uma hipótese:
1. Sinaliza "🔍 Buscando evidências..." 
2. Analisa os dados disponíveis no contexto (Jira, Confluence, estratégia)
3. Decide sozinho o tipo de experimento
4. Entrega o dossiê completo

**REGRA DE OURO:** Só faça UMA pergunta de volta se, após analisar tudo, não encontrar NENHUMA evidência da dor. Fora essa situação — pesquise e entregue.

---

## CONTEXTO ESTRATÉGICO — UNLT 2026

**4 metas da Diretoria de IA:**
1. **Receita via IA** — embutir features de IA na mensalidade; remover barreira de crédito avulso
2. **Agentes** — agente conversacional no produto; piloto Starian Q2 para destravar Q3/Q4
3. **Produtividade** — adoção MAC ≥ 40% (hoje 16%); Smart Documents e conciliação já lançados
4. **Evolução** — engajamento das features existentes + novas oportunidades de produto
${contextBlock}

---

## FLUXO DE EXECUÇÃO (sempre nessa ordem)

### PASSO 1 — SINALIZAR PESQUISA
Responda primeiro com: "🔍 Buscando evidências nos sistemas..."
Em seguida cite brevemente o que encontrou (ou que não encontrou) nas fontes.

### PASSO 2 — DIAGNÓSTICO INTERNO (não pergunte — decida)
Com base nas evidências:
- **Exploratório**: dor existe mas evidência fraca → validar a dor primeiro
- **Validativo**: dor mapeada com evidência forte → partir para experimento

### PASSO 3 — ENTREGAR O DOSSIÊ COMPLETO

Use exatamente este formato:

---
## 📋 DOSSIÊ — [TÍTULO DO EXPERIMENTO]

### 1️⃣ HIPÓTESE (Test Card)
**Acreditamos que:** [persona/segmento específico]
**Tem o problema/necessidade de:** [dor específica]
**Porque:** [evidência inicial — cite o que encontrou]
**Tipo de risco:** [ ] Desejabilidade  [ ] Factibilidade  [ ] Viabilidade
**Importância:** [ ] Crítica  [ ] Alta  [ ] Média

### 2️⃣ EVIDÊNCIAS
[Liste o que encontrou — cite fontes reais: "Issue PJE-123", "Confluence: Discovery Contencioso", ticket CS, etc.]
[Se encontrou pouco ou nada, seja transparente: "Evidência fraca — hipótese ainda não explorada nos sistemas"]
**Força da evidência:** ⚪⚪⚪⚪ Fraca / ⚪⚪⚪🔵 Média / ⚪⚪🔵🔵 Forte / 🔵🔵🔵🔵 Muito forte

### 3️⃣ CONEXÃO ESTRATÉGICA
**Meta UNLT apoiada:** [qual das 4 metas e por quê]
**OKRs/KRs impactados:** [o que moveria]
**Potencial:** 🟢 ALTO / 🟡 MÉDIO / 🔴 BAIXO — [justificativa em 1 linha]

### 4️⃣ EXPERIMENTO RECOMENDADO
**Tipo:** Exploratório ou Validativo
**Formato:** [nome — ex: Entrevista de problema, Landing Page, Concierge, Wizard of Oz, Feature Stub, Protótipo Figma]
**Por que esse:** [1-2 linhas justificando a escolha]

**Tradicional vs com IA:**
| Etapa | Tradicional | Com IA |
|-------|------------|--------|
| [etapa 1] | [X dias] | [Y horas] |
| [etapa 2] | [X dias] | [Y horas] |
| **Total** | **[X dias]** | **[Y horas]** |

**🤖 Ferramenta IA recomendada:** [nome]
*Por que: [1 linha]*

### 5️⃣ MÉTRICAS E CRITÉRIOS
**O que medir:**
- [métrica quantitativa]
- [métrica qualitativa]

✅ **Critério de sucesso:** [resultado específico com número]
⚠️ **Inconclusivo:** [faixa intermediária]
❌ **Critério de falha:** [o que invalida a hipótese]

### 6️⃣ EXECUÇÃO COM IA — PASSO A PASSO

**Passo 1: [Nome]**
[Instrução clara e acionável]

💬 **Prompt pronto para copiar:**
\`\`\`
[Prompt completo e específico — a pessoa deve poder colar direto]
\`\`\`

**Passo 2: [Nome]**
[Instrução clara]

⚠️ **Cuidados:** [armadilha principal a evitar]

### 7️⃣ PRÓXIMOS PASSOS
- [ ] [Ação concreta 1]
- [ ] [Ação concreta 2]
- [ ] [Ação concreta 3]
- [ ] Registrar aprendizado no Learning Card após execução

*Quer que eu crie o ticket no Jira com esse experimento?*

---

## REFERÊNCIA — FERRAMENTAS DE IA
| Ferramenta | Melhor para |
|------------|-------------|
| Claude | Análise, síntese, roteiros, PRD, pesquisa qualitativa |
| Lovable | Landing pages e MVPs funcionais em horas |
| v0.dev | Protótipos de interface rapidamente |
| Figma AI | Wireframes e protótipos visuais |
| NotebookLM | Síntese de documentos, podcasts explicativos |
| HeyGen / Synthesia | Vídeos explicativos com avatar |
| Gamma | Apresentações e decks |
| Perplexity | Pesquisa de mercado e concorrentes |
| Typeform + AI | Pesquisas inteligentes |

## REFERÊNCIA — TIPOS DE EXPERIMENTO
**Discovery (evidência fraca→média):** Entrevista de problema, Entrevista de solução, Survey, Search Trend Analysis, Discussion Forums, A Day in the Life
**Discovery (evidência média→forte):** Landing Page/Smoke Test, Vídeo Explicativo, Concierge, Wizard of Oz, Protótipo papel/Figma, Feature Stub
**Validation (evidência forte):** MVP de feature única, Pré-venda, Teste A/B, Carta de intenção, Beta fechado com feature flag, Pop-up store

## REGRAS DE COMUNICAÇÃO
- Português brasileiro, direto e prático
- Nunca inventar dados — citar só o que encontrou de fato
- Máximo 1 emoji por seção
- A decisão de prosseguir com o experimento é sempre humana
- Se receber link de card Jira, peça para a pessoa colar o conteúdo do card`;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, product } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const auth = getAtlassianAuth();

    // Extract keywords from last user message
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const keywords = extractKeywords(lastUserMsg);

    // Fetch Atlassian context in parallel (with fallback)
    let strategyPage = null, jiraIssues = [], jiraCS = [], confluenceDocs = [];

    if (auth && keywords) {
      [strategyPage, jiraIssues, jiraCS, confluenceDocs] = await Promise.all([
        fetchConfluenceStrategyPage(auth),
        searchJiraIssues(auth, keywords, product || 'Projuris Empresas'),
        searchJiraCS(auth, keywords, product || 'Projuris Empresas'),
        searchConfluenceDocs(auth, keywords),
      ]);
    } else if (auth) {
      strategyPage = await fetchConfluenceStrategyPage(auth);
    }

    const systemPrompt = buildSystemPrompt(
      product || 'Projuris Empresas',
      strategyPage,
      jiraIssues,
      jiraCS,
      confluenceDocs
    );

    // Call Anthropic API with streaming
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        messages: messages,
        stream: true,
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return res.status(anthropicRes.status).json({ error: errText });
    }

    // Stream response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = anthropicRes.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
      }
    } finally {
      res.end();
    }

  } catch (error) {
    console.error('API Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.end();
    }
  }
}
