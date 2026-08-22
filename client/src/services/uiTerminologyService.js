export const DEFAULT_UI_LANGUAGE = 'sv';

export const FACTORY_TERM_KEYS = Object.freeze({
  FACTORY_DIRECTOR: 'factoryDirector',
  FACTORY_STATUS: 'factoryStatus',
  AI_DECISION_JOURNAL: 'aiDecisionJournal',
  STRATEGY_FAMILY_TREE: 'strategyFamilyTree',
  STRATEGY_BRAIN: 'strategyBrain',
  AI_MEMORY: 'aiMemory',
  REPLAY_QUEUE: 'replayQueue',
  REPLAY_SCHEDULER: 'replayScheduler',
  REPLAY_ENGINE: 'replayEngine',
  HISTORICAL_BACKFILL: 'historicalBackfill',
  HISTORICAL_PRICE_FEED: 'historicalPriceFeed',
  STRATEGY_RUNTIME: 'strategyRuntime',
  STRATEGY_LIBRARY: 'strategyLibrary',
  STRATEGY_DNA: 'strategyDna',
  MARKET_DNA: 'marketDna',
  AI_OPTIMIZER: 'aiOptimizer',
  EVOLUTION_ENGINE: 'evolutionEngine',
  APPROVAL: 'approval',
  PAPER_TRADING: 'paperTrading',
  KNOWLEDGE_GAPS: 'knowledgeGaps',
  BLIND_SPOTS: 'blindSpots',
  CANDIDATE: 'candidate',
  DRAFT: 'draft',
  TESTING: 'testing',
  PAPER: 'paper',
  LIVE: 'live',
  RETIRED: 'retired',
  SIGNAL: 'signal',
  STRATEGY: 'strategy',
  BATCH: 'batch',
  SCORE: 'score',
  PAPER_ONLY: 'paperOnly',
  HISTORY: 'history',
  SHOW_PLAN: 'showPlan',
});

export const FACTORY_STATUS_KEYS = Object.freeze({
  RUNNING: 'running',
  WAITING: 'waiting',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  IDLE: 'idle',
});

export const FACTORY_DASHBOARD_PANEL_KEYS = Object.freeze({
  FACTORY: 'factory',
  BRAIN: 'brain',
  TESTS: 'tests',
  IMPROVEMENT: 'improvement',
  LIBRARY: 'library',
  MARKET: 'market',
  MEMORY: 'memory',
});

export const FACTORY_FLOW_STEP_KEYS = Object.freeze({
  DASHBOARD: 'dashboard',
  JOURNAL: 'journal',
  REPLAY: 'replay',
  LIBRARY: 'library',
  FAMILY: 'family',
  MARKET: 'market',
  REPLAY_AGAIN: 'replayAgain',
});

const SV_TERMS = Object.freeze({
  [FACTORY_TERM_KEYS.FACTORY_DIRECTOR]: {
    codeName: 'Factory Director',
    displayName: 'Nästa steg',
    description: 'Visar vad som bör göras härnäst.',
    why: 'Hjälper dig se nästa säkra steg utan att behöva förstå alla delar bakom.',
    expectedAction: 'Granska rekommendationen innan något arbete startas.',
  },
  [FACTORY_TERM_KEYS.FACTORY_STATUS]: {
    codeName: 'Factory Status',
    displayName: 'AI Fabriken',
    description: 'Visar hur hela fabriken mår just nu.',
    why: 'Samlar läget för data, tester, minne och godkännande på en plats.',
    expectedAction: 'Titta efter stopp eller väntande steg.',
  },
  [FACTORY_TERM_KEYS.AI_DECISION_JOURNAL]: {
    codeName: 'AI Decision Journal',
    displayName: 'AI-beslutsjournal',
    description: 'Visar alla AI-beslut som kan följas genom fabriken.',
    why: 'Gör det möjligt att se vad AI gjorde, varför det hände och vilket steg som följde.',
    expectedAction: 'Öppna en rad för att granska hela tidslinjen bakom beslutet.',
  },
  [FACTORY_TERM_KEYS.STRATEGY_FAMILY_TREE]: {
    codeName: 'Strategy Family Tree',
    displayName: 'Strategiträd',
    description: 'Visar hur strategiversioner hör ihop över tid.',
    why: 'Gör förbättringar och generationer spårbara utan att blanda dem med resultat.',
    expectedAction: 'Öppna en gren för att se vad som ändrades och vad som hände sedan.',
  },
  [FACTORY_TERM_KEYS.STRATEGY_BRAIN]: {
    codeName: 'Strategy Brain',
    displayName: 'AI tänker',
    description: 'Visar vad AI tycker skall göras härnäst.',
    why: 'Gör det tydligt om strategin behöver mer testdata, förbättring eller godkännande.',
    expectedAction: 'Följ rekommendationen eller undersök varför AI väntar.',
  },
  [FACTORY_TERM_KEYS.AI_MEMORY]: {
    codeName: 'AI Memory',
    displayName: 'Tidigare tester',
    description: 'Visar vilka tester som redan har körts så att AI inte gör samma arbete igen.',
    why: 'Skyddar mot dubbelarbete och gör tidigare försök synliga.',
    expectedAction: 'Kontrollera om testet redan finns innan du startar mer arbete.',
  },
  [FACTORY_TERM_KEYS.REPLAY_QUEUE]: {
    codeName: 'Replay Queue',
    displayName: 'Testkö',
    description: 'Visar vilka tester som väntar.',
    why: 'Gör väntande historiska tester lätta att granska.',
    expectedAction: 'Låt kön vara om testet redan väntar.',
  },
  [FACTORY_TERM_KEYS.REPLAY_SCHEDULER]: {
    codeName: 'Replay Scheduler',
    displayName: 'Testplanering',
    description: 'Planerar vilka tester som skall köras.',
    why: 'Ser till att rätt tester hamnar i kö utan att testet körs direkt.',
    expectedAction: 'Granska planen om något saknas eller känns fel.',
  },
  [FACTORY_TERM_KEYS.REPLAY_ENGINE]: {
    codeName: 'Replay Engine',
    displayName: 'Testmotor',
    description: 'Kör historiska tester.',
    why: 'Visar hur en strategi hade fungerat på tidigare marknadsdata.',
    expectedAction: 'Läs resultatet när testet är klart.',
  },
  [FACTORY_TERM_KEYS.HISTORICAL_BACKFILL]: {
    codeName: 'Historical Backfill',
    displayName: 'Historisk import',
    description: 'Laddar ned äldre marknadsdata från Interactive Brokers.',
    why: 'Fyller på data så att längre tester kan köras.',
    expectedAction: 'Vänta tills importen är klar innan du litar på längre tester.',
  },
  [FACTORY_TERM_KEYS.HISTORICAL_PRICE_FEED]: {
    codeName: 'Historical PriceFeed',
    displayName: 'Historisk marknadsdata',
    description: 'Visar sparade priser från tidigare marknader.',
    why: 'Ger testmotorn samma typ av prisdata varje gång.',
    expectedAction: 'Kontrollera dataluckor om tester saknas.',
  },
  [FACTORY_TERM_KEYS.STRATEGY_RUNTIME]: {
    codeName: 'Strategy Runtime',
    displayName: 'Strategimotor',
    description: 'Startar rätt strategi med rätt inställningar.',
    why: 'Gör att test och paper kan använda samma strategi på ett tydligt sätt.',
    expectedAction: 'Kontrollera att rätt strategiprofil används.',
  },
  [FACTORY_TERM_KEYS.STRATEGY_LIBRARY]: {
    codeName: 'Strategy Library',
    displayName: 'Strategibibliotek',
    description: 'Visar sparad historik och resultat för strategier.',
    why: 'Är platsen där resultat och livscykel kan granskas.',
    expectedAction: 'Använd detta som facit för hur strategin ligger till.',
  },
  [FACTORY_TERM_KEYS.STRATEGY_DNA]: {
    codeName: 'Strategy DNA',
    displayName: 'Strategiprofil',
    description: 'Visar hur strategin fungerar.',
    why: 'Gör strategins inställningar begripliga utan kodnamn.',
    expectedAction: 'Jämför profilen när nya versioner skapas.',
  },
  [FACTORY_TERM_KEYS.MARKET_DNA]: {
    codeName: 'Market DNA',
    displayName: 'Marknadstyp',
    description: 'Beskriver vilken typ av marknad strategin testades i.',
    why: 'Visar om resultatet kommer från rätt sorts marknad.',
    expectedAction: 'Se om fler marknadstyper behöver testas.',
  },
  [FACTORY_TERM_KEYS.AI_OPTIMIZER]: {
    codeName: 'AI Optimizer',
    displayName: 'AI förbättrar',
    description: 'AI försöker förbättra strategin.',
    why: 'Föreslår nya inställningar när strategin inte räcker till.',
    expectedAction: 'Granska förbättringsförslagen innan de testas.',
  },
  [FACTORY_TERM_KEYS.EVOLUTION_ENGINE]: {
    codeName: 'Evolution Engine',
    displayName: 'Strategiförbättring',
    description: 'Skapar nya versioner av strategin.',
    why: 'Håller ordning på hur en strategi förändras över tid.',
    expectedAction: 'Följ vilken version som testas.',
  },
  [FACTORY_TERM_KEYS.APPROVAL]: {
    codeName: 'Approval',
    displayName: 'Godkännande',
    description: 'Visar vad som måste godkännas manuellt.',
    why: 'Hindrar strategier från att gå vidare utan ett tydligt beslut.',
    expectedAction: 'Godkänn eller avvakta när du har granskat underlaget.',
  },
  [FACTORY_TERM_KEYS.PAPER_TRADING]: {
    codeName: 'Paper Trading',
    displayName: 'Paper Trading',
    description: 'Testar utan riktiga köp eller sälj.',
    why: 'Låter strategier prövas säkert innan riktig handel.',
    expectedAction: 'Följ resultaten och stoppa det som ser fel ut.',
  },
  [FACTORY_TERM_KEYS.KNOWLEDGE_GAPS]: {
    codeName: 'Knowledge Gaps',
    displayName: 'Saknade tester',
    description: 'Visar vad som ännu inte har testats.',
    why: 'Förklarar varför AI vill köra fler tester.',
    expectedAction: 'Prioritera tester som minskar osäkerheten mest.',
  },
  [FACTORY_TERM_KEYS.BLIND_SPOTS]: {
    codeName: 'Blind Spots',
    displayName: 'Otestade marknader',
    description: 'Visar marknader där strategin saknar erfarenhet.',
    why: 'Hindrar att en strategi ser stark ut för tidigt.',
    expectedAction: 'Testa fler marknadstyper innan strategin går vidare.',
  },
  [FACTORY_TERM_KEYS.CANDIDATE]: {
    codeName: 'Candidate',
    displayName: 'Redo för Paper',
    description: 'Visar en strategi som kan granskas för Paper Trading.',
    why: 'Markerar att strategin har tillräckligt stöd för nästa granskning.',
    expectedAction: 'Granska och besluta om godkännande.',
  },
  [FACTORY_TERM_KEYS.DRAFT]: {
    codeName: 'Draft',
    displayName: 'Under utveckling',
    description: 'Visar en strategi som inte är färdigtestad.',
    why: 'Gör tidiga idéer skilda från testade strategier.',
    expectedAction: 'Vänta på fler tester eller förbättringar.',
  },
  [FACTORY_TERM_KEYS.TESTING]: {
    codeName: 'Testing',
    displayName: 'Testas',
    description: 'Visar en strategi som håller på att prövas.',
    why: 'Gör det tydligt att resultatet fortfarande byggs upp.',
    expectedAction: 'Avvakta tills testunderlaget räcker.',
  },
  [FACTORY_TERM_KEYS.PAPER]: {
    codeName: 'Paper',
    displayName: 'Paper Trading',
    description: 'Visar att strategin testas utan riktiga order.',
    why: 'Skiljer säkra testaffärer från riktig handel.',
    expectedAction: 'Följ utfallet innan strategin går vidare.',
  },
  [FACTORY_TERM_KEYS.LIVE]: {
    codeName: 'Live',
    displayName: 'Live Trading',
    description: 'Visar att strategin hör till riktig handel.',
    why: 'Gör det tydligt när risken är verklig.',
    expectedAction: 'Var extra försiktig och följ riskläget.',
  },
  [FACTORY_TERM_KEYS.RETIRED]: {
    codeName: 'Retired',
    displayName: 'Arkiverad',
    description: 'Visar en strategi som inte längre används.',
    why: 'Håller gamla strategier kvar för historik utan att blanda dem med aktiva.',
    expectedAction: 'Använd den bara som jämförelse eller historik.',
  },
  [FACTORY_TERM_KEYS.SIGNAL]: {
    codeName: 'Signal',
    displayName: 'Signal',
    description: 'Ett tecken på att systemet hittat något intressant.',
    why: 'Visar varför en strategi kan vilja agera.',
    expectedAction: 'Granska sammanhanget innan du litar på signalen.',
  },
  [FACTORY_TERM_KEYS.STRATEGY]: {
    codeName: 'Strategy',
    displayName: 'Strategi',
    description: 'Ett sätt som systemet testar för att se om något fungerar bättre.',
    why: 'Gör varje testbar idé lättare att följa.',
    expectedAction: 'Jämför strategins testresultat innan du går vidare.',
  },
  [FACTORY_TERM_KEYS.BATCH]: {
    codeName: 'Batch',
    displayName: 'Många tester',
    description: 'Många tester i grupp.',
    why: 'Gör det lättare att jämföra flera varianter samtidigt.',
    expectedAction: 'Titta på bästa och svagaste resultaten.',
  },
  [FACTORY_TERM_KEYS.SCORE]: {
    codeName: 'Score',
    displayName: 'Betyg',
    description: 'En enkel bedömning av hur lovande något verkar just nu.',
    why: 'Sammanfattar resultat utan att ersätta granskning.',
    expectedAction: 'Använd betyget som startpunkt, inte som enda beslut.',
  },
  [FACTORY_TERM_KEYS.PAPER_ONLY]: {
    codeName: 'Paper only',
    displayName: 'Bara testläge',
    description: 'Bara testläge. Inga riktiga köp eller sälj görs.',
    why: 'Gör säkerhetsgränsen tydlig.',
    expectedAction: 'Använd läget för att granska utan verklig orderrisk.',
  },
  [FACTORY_TERM_KEYS.HISTORY]: {
    codeName: 'History',
    displayName: 'Historik',
    description: 'Visar vad systemet redan vet om strategin och vad som hänt tidigare.',
    why: 'Gör gamla resultat lätta att hitta.',
    expectedAction: 'Kontrollera historiken innan nya tester startas.',
  },
  [FACTORY_TERM_KEYS.SHOW_PLAN]: {
    codeName: 'Show plan',
    displayName: 'Visa plan',
    description: 'Öppnar en enkel förhandsgranskning av vad testet skulle innebära.',
    why: 'Gör testet begripligt innan det hamnar i kö.',
    expectedAction: 'Granska planen och fortsätt bara om den stämmer.',
  },
});

const SV_STATUS = Object.freeze({
  [FACTORY_STATUS_KEYS.RUNNING]: 'Körs',
  [FACTORY_STATUS_KEYS.WAITING]: 'Väntar',
  [FACTORY_STATUS_KEYS.PAUSED]: 'Pausad',
  [FACTORY_STATUS_KEYS.COMPLETED]: 'Klar',
  [FACTORY_STATUS_KEYS.FAILED]: 'Misslyckades',
  [FACTORY_STATUS_KEYS.IDLE]: 'Redo',
});

const SV_LIFECYCLE = Object.freeze({
  draft: SV_TERMS[FACTORY_TERM_KEYS.DRAFT].displayName,
  testing: SV_TERMS[FACTORY_TERM_KEYS.TESTING].displayName,
  learning: SV_TERMS[FACTORY_TERM_KEYS.TESTING].displayName,
  candidate: SV_TERMS[FACTORY_TERM_KEYS.CANDIDATE].displayName,
  paper: SV_TERMS[FACTORY_TERM_KEYS.PAPER].displayName,
  monitoring: SV_TERMS[FACTORY_TERM_KEYS.PAPER].displayName,
  approved: SV_TERMS[FACTORY_TERM_KEYS.PAPER].displayName,
  live: SV_TERMS[FACTORY_TERM_KEYS.LIVE].displayName,
  retired: SV_TERMS[FACTORY_TERM_KEYS.RETIRED].displayName,
});

const SV_ACTIONS = Object.freeze({
  re_test: 'Kör fler perioder',
  optimize: 'Justera inställningar',
  paper: SV_TERMS[FACTORY_TERM_KEYS.CANDIDATE].displayName,
  live_candidate: 'Kandidat för Live Trading',
  retire: 'Föreslås arkiveras',
  wait: 'Inget att göra',
});

const SV_GAPS = Object.freeze({
  missing_market_dna: SV_TERMS[FACTORY_TERM_KEYS.BLIND_SPOTS].displayName,
  missing_sample_size: 'För få affärer',
  missing_confidence: 'Låg säkerhet',
  missing_replay_periods: 'För få testperioder',
  missing_out_of_sample: 'Saknar extra kontrolltest',
  missing_paper: 'Saknar Paper Trading',
  missing_live: 'Saknar Live Trading',
});

const SV_FACTORY_DECISIONS = Object.freeze({
  SAFETY_HOLD: Object.freeze({
    title: 'Pausad av säkerhet',
    description: 'Fabriken väntar tills säkerhetsläget är tydligt.',
    next: 'Granska stopporsaken innan nästa arbete fortsätter.',
    tone: 'warning',
  }),
  REQUEST_BACKFILL_SERVICE: Object.freeze({
    title: 'Ladda historik',
    description: 'Fabriken behöver mer historisk marknadsdata.',
    next: 'Historisk import förbereds i bakgrunden.',
    tone: 'info',
  }),
  REQUEST_REPLAY_SCHEDULER: Object.freeze({
    title: 'Planera test',
    description: 'AI har hittat ett saknat test.',
    next: 'Testplanering lägger rätt test i kön.',
    tone: 'info',
  }),
  REQUEST_REPLAY_QUEUE: Object.freeze({
    title: 'Kör testkö',
    description: 'Det finns tester som väntar eller körs.',
    next: 'Testkön fortsätter tills arbetet är klart.',
    tone: 'info',
  }),
  REQUEST_AI_OPTIMIZER: Object.freeze({
    title: 'Förbättra strategi',
    description: 'En strategi behöver bättre inställningar.',
    next: 'AI tar fram nya förbättringsförslag.',
    tone: 'warning',
  }),
  REQUEST_EVOLUTION_ENGINE: Object.freeze({
    title: 'Skapa ny version',
    description: 'Ett förbättringsförslag behöver bli en ny strategiversion.',
    next: 'Strategiförbättring skapar nästa generation.',
    tone: 'warning',
  }),
  REQUEST_APPROVAL_SERVICE: Object.freeze({
    title: 'Väntar på godkännande',
    description: 'En strategi är redo att granskas för Paper Trading.',
    next: 'Godkännande krävs innan Paper Trading.',
    tone: 'success',
  }),
  IDLE: Object.freeze({
    title: SV_STATUS[FACTORY_STATUS_KEYS.IDLE],
    description: 'Inget nytt arbete behövs just nu.',
    next: 'Fabriken väntar på ny data eller ett nytt beslut.',
    tone: 'success',
  }),
});

const SV_FACTORY_REASONS = Object.freeze({
  factory_safety_blocked: 'Ett säkerhetsvillkor stoppar fabriken.',
  historical_backfill_required: 'Mer historisk marknadsdata behövs.',
  strategy_brain_found_knowledge_gap: 'AI har hittat ett saknat test.',
  replay_job_pending: 'Ett historiskt test väntar på att köras.',
  replay_job_already_active: 'Ett historiskt test körs redan.',
  strategy_brain_requested_optimization: 'AI har hittat en strategi som behöver förbättras.',
  optimizer_pending: 'Ett förbättringsförslag väntar på nästa steg.',
  library_quality_flag: 'Strategibiblioteket visar att kvaliteten behöver förbättras.',
  optimizer_candidates_require_lineage: 'Ett förslag behöver bli en spårbar ny version.',
  candidate_requires_manual_approval: 'En strategi behöver granskas innan Paper Trading.',
  no_factory_action_required: 'Inget nytt arbete behövs just nu.',
  learning_summary_requested_replay: 'Lärandet visar att ett nytt historiskt test behövs.',
  learning_summary_requested_optimization: 'Lärandet visar att strategin behöver förbättras.',
  learning_summary_requested_approval: 'Lärandet visar att strategin är redo för granskning.',
  no_trades: 'Testet gav inga affärer.',
  needs_more_samples: 'AI behöver fler affärer innan slutsatsen är stark.',
  qualified_replay: 'Testet uppfyller kvalitetskraven.',
  strategy_worked_in_market: 'Strategin fungerade i den här marknadstypen.',
  loss_making_in_market: 'Strategin var svag i den här marknadstypen.',
  mixed_result: 'Resultatet var blandat och kräver mer underlag.',
});

const SV_COPY = Object.freeze({
  panelHelpLabels: Object.freeze({
    description: 'Kort beskrivning',
    why: 'Varför panelen finns',
    expectedAction: 'Vad du kan göra',
  }),
  factoryDashboard: Object.freeze({
    title: SV_TERMS[FACTORY_TERM_KEYS.FACTORY_STATUS].displayName,
    subtitle: 'Ett kontrollrum som visar vad fabriken gör, varför det händer och vad nästa steg blir.',
    helpButton: 'Hjälp',
    refreshButton: 'Uppdatera',
    emptyValue: '—',
    unavailable: 'Data saknas',
    loading: 'Hämtar läget',
    updated: 'Uppdaterad',
    readOnly: 'Läsvy',

    // ── Meridian: startsidan "Idag" ─────────────────────────────────────────
    //
    // Sidan svarar på fyra frågor i fast ordning: vad händer, varför händer
    // det, behöver jag göra något, vad blir nästa steg.
    //
    // Copy-principerna ur designrapporten gäller varje sträng här:
    // rubriker är påståenden och inte etiketter; ingen siffra står utan
    // omdöme; tomlägen är besked och inte ursäkter. "Ingenting väntar på dig"
    // är ett BRA besked och skrivs därför ut, aldrig bortgömt.
    today: Object.freeze({
      tabs: Object.freeze({
        today: 'Idag',
        work: 'Arbetet',
      }),
      since: 'sedan',
      hero: Object.freeze({
        working: 'AI:n arbetar.',
        waiting: 'AI:n väntar.',
        paused: 'AI:n har pausat.',
        idle: 'AI:n är klar för stunden.',
        nothingForYou: 'Ingenting väntar på dig.',
        oneThingForYou: 'En sak väntar på dig.',
      }),
      needsYou: Object.freeze({
        eyebrow: 'Behöver dig',
        counterNone: 'inget kvar',
        counterOne: '1 kvar',
        emptyTitle: 'Ingenting väntar på dig',
        emptyBody: 'AI:n arbetar vidare på egen hand. Det finns inget godkännande, ingen import och ingen granskning som kräver dig just nu.',
        why: 'Varför',
        next: 'Vad som händer nu',
        openJournal: 'Läs vad AI:n gjort',
      }),
      state: Object.freeze({
        eyebrow: 'Läget',
        working: 'AI:n arbetar',
        waiting: 'AI:n väntar',
        needsDecision: 'AI:n behöver ett beslut',
        done: 'AI:n är klar',
        workCard: Object.freeze({
          eyebrow: 'AI:ns arbete',
          running: 'pågår',
          queued: 'väntar på plats',
          finished: 'klara i dygnet',
          failed: 'behöver ses över',
          nothing: 'Inga tester igång. AI:n väntar på nästa möjlighet.',
          open: 'Se vad AI:n gör',
        }),
        strategyCard: Object.freeze({
          eyebrow: 'Strategier',
          proving: 'prövas',
          waitingForYou: 'väntar på dig',
          inPaper: 'i Paper Trading',
          nothing: 'Inga strategier har nått provstadiet ännu.',
          open: 'Öppna strategibiblioteket',
        }),
        marketCard: Object.freeze({
          eyebrow: 'Marknaden',
          nothing: 'Ingen marknadsperiod är analyserad ännu.',
          latest: 'Senast analyserad',
          open: 'Vad betyder det?',
        }),
      }),
      recent: Object.freeze({
        eyebrow: 'Medan du var borta',
        empty: 'Ingenting har hänt sedan du var här sist.',
        openJournal: 'Hela journalen',
        // Etiketten säger vad slags händelse raden är, inte vilket system den
        // kom ifrån. Den som läser bryr sig om ifall något kräver dem.
        badges: Object.freeze({
          info: 'Pågår',
          success: 'Klart',
          warning: 'Väntar',
          danger: 'Stoppat',
          neutral: 'Rutin',
        }),
      }),
      brain: Object.freeze({
        eyebrow: 'AI tänker',
        empty: 'AI:n har inget att föreslå ännu. Den behöver fler resultat först.',
        gapTitle: 'Det saknas data',
        // Ett kunskapshål är inte ett underkännande. Meningen är formulerad så
        // att den går att åtgärda i stället för att låta som en dom.
        gapExplanation: 'Strategin har aldrig prövats i den här sortens marknad. Resultatet säger därför ingenting om den.',
        nextTestTitle: 'Nästa test AI:n vill köra',
        recommendationTitle: 'AI:ns rekommendation',
        openLibrary: 'Öppna strategibiblioteket',
      }),
    }),

    // ── Meridian: fliken "Arbetet" ──────────────────────────────────────────
    //
    // Sex begripliga steg ersätter fem interna system. Stegen är produktens
    // verkliga arbetsordning, inte en bild av arkitekturen — och sidan får
    // därför inte visa jobb-id, körningsnummer, kö-namn eller hashar.
    pipeline: Object.freeze({
      eyebrow: 'Arbetet',
      title: 'Så här arbetar AI:n',
      subtitle: 'Sex steg, alltid i samma ordning. Du behöver inte styra något av dem.',
      closeHint: 'Du kan stänga den här sidan. Inget stannar för att du tittar bort.',
      stepLabel: 'Steg',
      steps: Object.freeze({
        import: Object.freeze({
          title: 'Import',
          body: 'Hämtar marknadshistorik så att tester kan köras på riktig data.',
          unit: 'perioder',
        }),
        tests: Object.freeze({
          title: 'Historiska tester',
          body: 'Kör strategin genom tidigare marknader för att se om den håller.',
          unit: 'tester',
        }),
        learnings: Object.freeze({
          title: 'Lärdomar',
          body: 'Läser av resultaten och sparar vad de betyder.',
          unit: 'lärdomar',
        }),
        improvement: Object.freeze({
          title: 'Strategiförbättring',
          body: 'Bygger nya varianter av det som fungerat.',
          unit: 'versioner',
        }),
        approval: Object.freeze({
          title: 'Godkännande',
          body: 'Lägger fram färdiga strategier för dig att ta ställning till.',
          unit: 'väntar',
        }),
        paper: Object.freeze({
          title: 'Paper Trading',
          body: 'Följer strategin mot dagens marknad, utan riktiga pengar.',
          unit: 'strategier',
        }),
      }),
      learned: Object.freeze({
        eyebrow: 'Vad AI:n lärde sig',
        empty: 'Inga lärdomar registrerade ännu.',
      }),
      attention: Object.freeze({
        eyebrow: 'Behöver ses över',
        empty: 'Ingenting har gått fel.',
        // En stoppad testgrupp namnges efter vad den var, inte efter sitt id.
        batchLabel: 'En testgrupp stoppades',
      }),
    }),

    labels: Object.freeze({
      what: 'Vad är detta?',
      now: 'Vad händer just nu?',
      why: 'Varför händer det?',
      nextStep: 'Vad blir nästa steg?',
      needsAction: 'Behöver jag göra något?',
      status: 'Status',
      progress: 'Framsteg',
      waiting: 'Väntar',
      running: 'Körs',
      completed: 'Klara',
      failed: 'Misslyckade',
      workingState: 'Arbetar / väntar / klar',
      activePhase: 'Aktiv fas',
      latestActivity: 'Senaste aktivitet',
      nextActivity: 'Nästa aktivitet',
      lastUpdated: 'Senast uppdaterad',
      currentWork: 'AI gör just nu',
      discovered: 'AI har upptäckt',
      missing: 'Saknas',
      biggestGap: 'Största kunskapshål',
      recommendedTest: 'Rekommenderat test',
      recommendedStrategy: 'Rekommenderad strategi',
      recommendedMarket: 'Rekommenderad marknad',
      informationValue: 'Informationsvärde',
      recommendationReason: 'Varför',
      testQueue: SV_TERMS[FACTORY_TERM_KEYS.REPLAY_QUEUE].displayName,
      pendingTests: 'Tester väntar',
      runningTests: 'Tester körs',
      completedTests: 'Tester klara',
      failedTests: 'Tester misslyckades',
      improvedStrategy: 'Strategi som förbättras',
      originStrategy: 'Ursprunglig strategi',
      changes: 'Ändrat',
      dnaVersion: SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_DNA].displayName,
      generation: 'Generation',
      underDevelopment: SV_TERMS[FACTORY_TERM_KEYS.DRAFT].displayName,
      learning: 'Lär sig',
      testing: SV_TERMS[FACTORY_TERM_KEYS.TESTING].displayName,
      paperReady: SV_TERMS[FACTORY_TERM_KEYS.CANDIDATE].displayName,
      paperTrading: SV_TERMS[FACTORY_TERM_KEYS.PAPER].displayName,
      liveTrading: SV_TERMS[FACTORY_TERM_KEYS.LIVE].displayName,
      archived: SV_TERMS[FACTORY_TERM_KEYS.RETIRED].displayName,
      currentMarket: 'Aktuell marknad',
      marketType: SV_TERMS[FACTORY_TERM_KEYS.MARKET_DNA].displayName,
      trend: 'Trend',
      volatility: 'Volatilitet',
      session: 'Session',
      lastAnalyzed: 'Senast analyserad',
      previousExperiments: 'Körda experiment',
      reusedResults: 'Återanvända resultat',
      similarTests: 'Liknande tester',
      latestReplay: 'Senaste historiska test',
      latestBatch: 'Senaste testgrupp',
      latestImprovement: 'Senaste förbättring',
      memoryReuse: 'Återanvänt resultat',
      dataSources: 'Datakällor',
      availableSources: 'Tillgängliga',
      missingSources: 'Saknar data',
      estimatedTime: 'Beräknad tid',
      latestImprovements: 'Senaste förbättringar',
      latestFailures: 'Senaste misslyckanden',
      latestLearnings: 'Senaste lärdomar',
    }),
    units: Object.freeze({
      versions: 'versioner',
      tests: 'tester',
      experiments: 'experiment',
      strategies: 'strategier',
    }),
    marketLabels: Object.freeze({
      trend: Object.freeze({
        up_strong: 'Kraftigt uppåt',
        up: 'Uppåt',
        down_strong: 'Kraftigt nedåt',
        down: 'Nedåt',
        flat: 'Sidledes',
        mixed: 'Blandad',
        unknown: 'Okänt',
      }),
      volatility: Object.freeze({
        dead: 'Mycket låg',
        quiet: 'Låg',
        low: 'Låg',
        normal: 'Normal',
        elevated: 'Förhöjd',
        high: 'Hög',
        volatile: 'Hög',
        unknown: 'Okänt',
      }),
      session: Object.freeze({
        rth: 'Ordinarie handel',
        regular: 'Ordinarie handel',
        cash: 'Ordinarie handel',
        globex: 'Futures-session',
        overnight: 'Kväll och natt',
        premarket: 'Före öppning',
        afterhours: 'Efter stängning',
        unknown: 'Okänt',
      }),
    }),
    states: Object.freeze({
      working: 'Arbetar',
      waiting: 'Väntar',
      done: 'Klar',
      unknown: 'Okänt',
      noRecommendation: 'Ingen rekommendation ännu',
      noMissingTests: 'Inga saknade tester visas just nu.',
      noStrategy: 'Ingen strategi vald',
      noMarketSelected: 'Ingen marknad vald',
      noChanges: 'Inga ändringar visas ännu',
      noMarket: 'Ingen marknadstyp visas ännu',
      noSession: 'Ingen session visas ännu',
      noSimilarTests: 'Inga liknande tester visas ännu',
      noTestsYet: 'Inga tester ännu',
      noReplayYet: 'Inget historiskt test ännu',
      noBatchYet: 'Ingen testgrupp ännu',
      noImprovementYet: 'Ingen förbättring ännu',
      noQueueJobs: 'Inga jobb i testkön',
      noRecentActivity: 'Ingen aktivitet ännu',
      noNextActivity: 'AI väntar på mer data',
      noActionNeeded: 'Nej, AI arbetar vidare.',
      checkSystem: 'Kontrollera systemläget.',
      noMemoryReuse: 'Inget resultat har återanvänts ännu',
      noEstimatedTime: 'Beräknas inte ännu',
      noFailures: 'Inga misslyckanden visas just nu.',
      noLearnings: 'Inga lärdomar visas ännu.',
      sourceMissing: 'Källan svarar inte just nu.',
      genericReason: 'Beslutet bygger på aktuellt fabriksläge.',
    }),
    activityLabels: Object.freeze({
      decision: 'Nytt beslut',
      queue: 'Testkö uppdaterad',
      replay: 'Historiskt test klart',
      batch: 'Testgrupp uppdaterad',
      improvement: 'Förbättring skapad',
      learning: 'Lärdom sparad',
      memory: 'Tidigare test registrerat',
      market: 'Marknad analyserad',
      library: 'Strategibibliotek uppdaterat',
    }),
    yesNo: Object.freeze({
      yes: 'Ja',
      no: 'Nej',
    }),
    mutationLabels: Object.freeze({
      parameter: 'Parametrar',
      structure: 'Struktur',
      risk: 'Risknivå',
      timing: 'Tajming',
      entry: 'Ingång',
      exit: 'Utgång',
      unknown: 'Ändring',
    }),
    live: Object.freeze({
      title: 'Livevy',
      subtitle: 'Fabriken uppdateras automatiskt med senaste kända läge.',
      autoRefresh: 'Uppdateras automatiskt',
      nowTitle: 'Vad gör AI just nu?',
      whyTitle: 'Varför?',
      nextTitle: 'Vad händer härnäst?',
      stepsTitle: 'Fabrikens steg',
      historyTitle: 'Senaste händelser',
      progressDone: '100%',
      progressWaiting: '0%',
      stepReasons: Object.freeze({
        aiWorking: 'AI har ett aktivt nästa steg.',
        aiWaiting: 'AI väntar tills mer data eller ett nytt resultat finns.',
        replayRunning: 'Ett test behandlas just nu.',
        replayCompleted: 'Ett test finns sparat.',
        learning: 'En lärdom finns kopplad till senaste resultat.',
        brain: 'AI har identifierat vad som bör undersökas.',
        mutation: 'En ny strategiversion eller ändring finns i trädet.',
        candidate: 'Minst en strategi är redo för granskning.',
        paper: 'Minst en strategi följs i Paper Trading.',
        live: 'Minst en strategi är i Live Trading.',
      }),
      steps: Object.freeze({
        aiWorking: Object.freeze({ icon: '●', label: 'AI arbetar' }),
        aiWaiting: Object.freeze({ icon: '○', label: 'AI väntar' }),
        replayRunning: Object.freeze({ icon: '▶', label: 'Test körs' }),
        replayCompleted: Object.freeze({ icon: '✓', label: 'Test färdigt' }),
        learning: Object.freeze({ icon: '◇', label: 'Lärdom' }),
        brain: Object.freeze({ icon: '◆', label: SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_BRAIN].displayName }),
        mutation: Object.freeze({ icon: '△', label: 'Ändring' }),
        candidate: Object.freeze({ icon: '□', label: SV_TERMS[FACTORY_TERM_KEYS.CANDIDATE].displayName }),
        paper: Object.freeze({ icon: '▣', label: SV_TERMS[FACTORY_TERM_KEYS.PAPER].displayName }),
        live: Object.freeze({ icon: '■', label: SV_TERMS[FACTORY_TERM_KEYS.LIVE].displayName }),
      }),
    }),
    workflow: Object.freeze({
      actionCenter: Object.freeze({
        title: 'Behöver dig',
        subtitle: 'Konkreta uppgifter från hela fabriken.',
        emptyTitle: 'Inget behöver göras',
        emptyExplanation: 'AI väntar eller arbetar vidare utan att du behöver agera.',
        emptyWhy: 'Det finns inget godkännande, ingen import och ingen granskning som kräver dig just nu.',
        emptyButton: 'Visa beslutsjournal',
        priority: 'Prioritet',
        explanation: 'Enkel förklaring',
      }),
      aiStatus: Object.freeze({
        title: 'AI:ns läge',
        subtitle: 'Kort svar på vad AI gör och vad som händer sedan.',
        what: 'Vad gör AI?',
        why: 'Varför gör AI det?',
        progress: 'Hur långt har den kommit?',
        next: 'Vad händer sedan?',
      }),
      activityFeed: Object.freeze({
        title: 'Aktivitetsflöde',
        subtitle: 'Viktiga händelser från fabriken.',
        empty: 'Inga viktiga händelser ännu.',
      }),
      timeline: Object.freeze({
        title: 'Fabrikens tidslinje',
        subtitle: 'Hela resan för senaste strategi eller test.',
        empty: 'Ingen sammanhängande resa att visa ännu.',
        open: 'Öppna',
        missing: Object.freeze({
          tests: 'Inga tester har körts ännu.',
          history: 'AI väntar på historisk data.',
          improvements: 'Inga förbättringar har gjorts ännu.',
        }),
        events: Object.freeze({
          historyImported: Object.freeze({
            icon: '↧',
            title: 'Historik importerad',
            description: 'Marknadsdata finns redo för tester.',
            href: '/factory/replay',
          }),
          opportunityFound: Object.freeze({
            icon: '◇',
            title: 'AI hittade en möjlighet',
            description: 'AI har hittat något som bör undersökas.',
            href: '/decision-journal',
          }),
          testStarted: Object.freeze({
            icon: '▶',
            title: 'Historiskt test startade',
            description: 'Ett historiskt test körs eller väntar på att köras.',
            href: '/factory/replay',
          }),
          testCompleted: Object.freeze({
            icon: '✓',
            title: 'Historiskt test klart',
            description: 'Resultatet finns att granska.',
            href: '/factory/replay',
          }),
          learned: Object.freeze({
            icon: '◆',
            title: 'AI lärde sig något',
            description: 'En ny lärdom har sparats från resultatet.',
            href: '/decision-journal',
          }),
          improved: Object.freeze({
            icon: '△',
            title: 'Strategin förbättrades',
            description: 'En ny version eller ändring finns att följa.',
            href: '/factory/library',
          }),
          promoted: Object.freeze({
            icon: '□',
            title: 'Strategin gick vidare till nästa steg',
            description: 'Strategin är redo för nästa granskning.',
            href: '/factory/library',
          }),
          paperStarted: Object.freeze({
            icon: '▣',
            title: 'Paper Trading startade',
            description: 'Strategin följs i Paper Trading.',
            href: '/futures-paper',
          }),
          approved: Object.freeze({
            icon: '■',
            title: 'Godkänd',
            description: 'Strategin har godkänts för nästa säkra miljö.',
            href: '/futures-paper?tab=godkannande',
          }),
        }),
      }),
      priorityLabels: Object.freeze({
        high: 'Hög',
        medium: 'Mellan',
        low: 'Låg',
      }),
      progress: Object.freeze({
        waiting: 'Väntar',
        active: 'Pågår',
        done: 'Klar',
      }),
      actions: Object.freeze({
        checkSystem: Object.freeze({
          title: 'Kontrollera systemet',
          explanation: 'Fabriken är stoppad eller behöver uppmärksamhet.',
          why: 'Säkerheten går först innan nya tester eller godkännanden fortsätter.',
          priority: 'high',
          button: 'Öppna system',
          href: '/system',
        }),
        approveStrategy: Object.freeze({
          title: 'Godkänn strategi',
          explanation: 'Det finns en strategi som är redo för Paper.',
          why: 'Strategin behöver mänsklig granskning innan den följs i Paper Trading.',
          priority: 'high',
          button: 'Öppna godkännande',
          href: '/futures-paper?tab=godkannande',
        }),
        importHistory: Object.freeze({
          title: 'Importera historik',
          explanation: 'AI behöver mer historisk marknadsdata innan nästa steg blir säkert.',
          why: 'Längre historik gör testerna mer tillförlitliga.',
          priority: 'high',
          button: 'Öppna system',
          href: '/system?tab=providers',
        }),
        waitTests: Object.freeze({
          title: 'Vänta på tester',
          explanation: 'Tester väntar eller körs just nu.',
          why: 'AI behöver resultatet innan den kan lära sig eller föreslå nästa steg.',
          priority: 'low',
          button: 'Visa tester',
          href: '/factory/replay',
        }),
        reviewPaper: Object.freeze({
          title: 'Granska Paper-resultat',
          explanation: 'Minst en strategi följs i Paper Trading.',
          why: 'Paper-resultat visar om strategin håller utanför historiska tester.',
          priority: 'medium',
          button: 'Öppna handelstest',
          href: '/futures-paper',
        }),
        noAction: Object.freeze({
          title: 'Inget behöver göras',
          explanation: 'AI arbetar vidare eller väntar på mer data.',
          why: 'Det finns inget som kräver manuell åtgärd just nu.',
          priority: 'low',
          button: 'Visa beslutsjournal',
          href: '/decision-journal',
        }),
      }),
      events: Object.freeze({
        aiStartedTesting: 'AI började testa',
        testCompleted: 'Test färdigt',
        strategyCandidate: 'Strategi flyttad till Redo för Paper',
        strategyApprovedPaper: 'Strategi godkänd för Paper',
        historyImported: 'Historik importerad',
        learningSaved: 'Ny lärdom sparad',
        strategyImproved: 'Strategi förbättrad',
      }),
    }),
    panels: Object.freeze({
      [FACTORY_DASHBOARD_PANEL_KEYS.FACTORY]: Object.freeze({
        icon: '🏭',
        termKey: FACTORY_TERM_KEYS.FACTORY_STATUS,
        title: SV_TERMS[FACTORY_TERM_KEYS.FACTORY_STATUS].displayName,
        description: 'Visar hela fabrikens arbetsläge.',
        why: 'Du ser direkt om AI arbetar, väntar eller är klar.',
        next: 'Nästa rekommenderade steg visas här.',
      }),
      [FACTORY_DASHBOARD_PANEL_KEYS.BRAIN]: Object.freeze({
        icon: '🧠',
        termKey: FACTORY_TERM_KEYS.STRATEGY_BRAIN,
        title: SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_BRAIN].displayName,
        description: SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_BRAIN].description,
        why: 'Panelen förklarar vad AI har upptäckt och vad som saknas.',
        next: 'Den visar vilken strategi som bör testas härnäst och varför.',
      }),
      [FACTORY_DASHBOARD_PANEL_KEYS.TESTS]: Object.freeze({
        icon: '🔬',
        termKey: FACTORY_TERM_KEYS.REPLAY_QUEUE,
        title: 'Pågående tester',
        description: 'Visar tester som väntar, körs eller är klara.',
        why: 'Du ser om fabriken faktiskt arbetar eller väntar på testkön.',
        next: 'När ett test är klart kan resultatet läsas i strategibiblioteket.',
      }),
      [FACTORY_DASHBOARD_PANEL_KEYS.IMPROVEMENT]: Object.freeze({
        icon: '🧪',
        termKey: FACTORY_TERM_KEYS.EVOLUTION_ENGINE,
        title: SV_TERMS[FACTORY_TERM_KEYS.EVOLUTION_ENGINE].displayName,
        description: SV_TERMS[FACTORY_TERM_KEYS.EVOLUTION_ENGINE].description,
        why: 'Du ser vilken strategi som förbättras och hur långt arbetet har kommit.',
        next: 'Nästa version testas innan den kan gå vidare.',
      }),
      [FACTORY_DASHBOARD_PANEL_KEYS.LIBRARY]: Object.freeze({
        icon: '📚',
        termKey: FACTORY_TERM_KEYS.STRATEGY_LIBRARY,
        title: SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_LIBRARY].displayName,
        description: 'Visar var strategierna befinner sig i livscykeln.',
        why: 'Strategibiblioteket är facit för resultat och status.',
        next: 'Strategier med tillräckligt stöd kan gå till godkännande.',
      }),
      [FACTORY_DASHBOARD_PANEL_KEYS.MARKET]: Object.freeze({
        icon: '📈',
        termKey: FACTORY_TERM_KEYS.MARKET_DNA,
        title: 'Marknad',
        description: 'Visar vilken typ av marknad systemet ser i datan.',
        why: 'Strategier behöver testas i flera marknadstyper innan de kan bedömas.',
        next: 'Otestade marknader blir saknade tester.',
      }),
      [FACTORY_DASHBOARD_PANEL_KEYS.MEMORY]: Object.freeze({
        icon: '🕘',
        termKey: FACTORY_TERM_KEYS.AI_MEMORY,
        title: SV_TERMS[FACTORY_TERM_KEYS.AI_MEMORY].displayName,
        description: SV_TERMS[FACTORY_TERM_KEYS.AI_MEMORY].description,
        why: 'Panelen visar om AI kan återanvända tidigare resultat.',
        next: 'Om ett liknande test redan finns ska fabriken använda det i stället för att köra om.',
      }),
    }),
  }),
  factoryFlowNavigation: Object.freeze({
    ariaLabel: 'Fabriksgenvägar',
    title: 'Fabriksgenvägar',
    subtitle: 'Snabba länkar till de viktigaste produktvyerna.',
    current: 'Här',
    open: 'Öppna',
    order: Object.freeze([
      FACTORY_FLOW_STEP_KEYS.DASHBOARD,
      FACTORY_FLOW_STEP_KEYS.REPLAY,
      FACTORY_FLOW_STEP_KEYS.LIBRARY,
      FACTORY_FLOW_STEP_KEYS.JOURNAL,
    ]),
    items: Object.freeze({
      [FACTORY_FLOW_STEP_KEYS.DASHBOARD]: Object.freeze({
        label: SV_TERMS[FACTORY_TERM_KEYS.FACTORY_STATUS].displayName,
        path: '/factory',
        summary: 'Kontrollrum för vad fabriken gör nu.',
      }),
      [FACTORY_FLOW_STEP_KEYS.JOURNAL]: Object.freeze({
        label: SV_TERMS[FACTORY_TERM_KEYS.AI_DECISION_JOURNAL].displayName,
        path: '/decision-journal',
        summary: 'Alla beslut och varför de togs.',
      }),
      [FACTORY_FLOW_STEP_KEYS.REPLAY]: Object.freeze({
        label: 'Tester',
        path: '/factory/replay',
        summary: 'Se historiska tester och resultat.',
      }),
      [FACTORY_FLOW_STEP_KEYS.LIBRARY]: Object.freeze({
        label: SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_LIBRARY].displayName,
        path: '/factory/library',
        summary: 'Resultat och livscykel för strategier.',
      }),
      [FACTORY_FLOW_STEP_KEYS.FAMILY]: Object.freeze({
        label: SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_FAMILY_TREE].displayName,
        path: '/factory/family-tree',
        summary: 'Generationer och samband mellan versioner.',
      }),
      [FACTORY_FLOW_STEP_KEYS.MARKET]: Object.freeze({
        label: SV_TERMS[FACTORY_TERM_KEYS.MARKET_DNA].displayName,
        path: '/factory/market-dna',
        summary: 'Marknadstyper som testerna bygger på.',
      }),
      [FACTORY_FLOW_STEP_KEYS.REPLAY_AGAIN]: Object.freeze({
        label: 'Testa igen',
        path: '/factory/replay',
        summary: 'Tillbaka till historiska tester.',
      }),
    }),
  }),
  aiDecisionJournal: Object.freeze({
    title: SV_TERMS[FACTORY_TERM_KEYS.AI_DECISION_JOURNAL].displayName,
    subtitle: 'En läsvy som samlar beslut, tester, lärdomar och nästa steg från fabriken.',
    readOnly: 'Läsvy',
    refreshButton: 'Uppdatera',
    loading: 'Hämtar journalen',
    updated: 'Uppdaterad',
    openRow: 'Öppna tidslinje',
    selectedRow: 'Valt beslut',
    emptyValue: '—',
    labels: Object.freeze({
      total: 'Beslut',
      withResults: 'Med resultat',
      reusedMemory: 'Återanvända',
      activeNextSteps: 'Nästa steg',
      sources: 'Datakällor',
      availableSources: 'Tillgängliga',
      missingSources: 'Saknar data',
      timeline: 'Beslutstidslinje',
      details: 'Beslutsdetaljer',
      help: 'Förklaring',
      source: 'Källa',
    }),
    timelineFields: Object.freeze({
      time: 'Tid',
      duration: 'Varaktighet',
      status: 'Status',
      result: 'Resultat',
      happened: 'Vad hände?',
      why: 'Varför?',
      outcome: 'Vad blev resultatet?',
      current: 'Vad gör AI nu?',
      open: 'Öppna steg',
    }),
    columns: Object.freeze({
      time: 'Tid',
      strategy: SV_TERMS[FACTORY_TERM_KEYS.STRATEGY].displayName,
      market: 'Marknad',
      replay: 'Historiskt test',
      learning: 'Lärdom',
      memory: SV_TERMS[FACTORY_TERM_KEYS.AI_MEMORY].displayName,
      recommendation: 'Rekommendation',
      mutation: 'Ändring',
      result: 'Resultat',
      why: 'Varför AI tog beslutet',
      next: 'Vad nästa steg blir',
    }),
    timeline: Object.freeze({
      replay: SV_TERMS[FACTORY_TERM_KEYS.REPLAY_ENGINE].displayName,
      learning: 'Lärdom',
      memory: SV_TERMS[FACTORY_TERM_KEYS.AI_MEMORY].displayName,
      brain: SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_BRAIN].displayName,
      director: SV_TERMS[FACTORY_TERM_KEYS.FACTORY_DIRECTOR].displayName,
      optimizer: SV_TERMS[FACTORY_TERM_KEYS.AI_OPTIMIZER].displayName,
      evolution: SV_TERMS[FACTORY_TERM_KEYS.EVOLUTION_ENGINE].displayName,
      library: SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_LIBRARY].displayName,
    }),
    timelineActions: Object.freeze({
      replay: 'Öppna historiskt test',
      learning: 'Visa lärdom',
      memory: 'Visa tidigare experiment',
      brain: 'Visa AI:s resonemang',
      director: 'Visa nästa steg',
      optimizer: 'Visa parameterändringar',
      evolution: 'Visa generationshistorik',
      library: 'Visa strategins liv',
    }),
    timelineReasons: Object.freeze({
      replay: 'Visar vilket historiskt test som hör till beslutet.',
      learning: 'Visar vad AI lärde sig av testet.',
      memory: 'Visar om ett tidigare test användes eller registrerades.',
      brain: 'Visar vilket kunskapshål AI såg.',
      director: 'Visar vilket nästa steg fabriken rekommenderade.',
      optimizer: 'Visar om AI tog fram förbättringsförslag.',
      evolution: 'Visar om en ny strategiversion skapades.',
      library: 'Visar var resultatet finns sparat.',
    }),
    states: Object.freeze({
      noDecisions: 'Inga AI-beslut ännu.',
      noTimeline: 'Ingen tidslinje vald ännu.',
      noStrategy: 'Ingen strategi vald',
      noMarket: 'Ingen marknad vald',
      noReplay: 'Inget historiskt test kopplat',
      noLearning: 'Ingen lärdom registrerad',
      noMemory: 'Inget tidigare test kopplat',
      noRecommendation: 'Ingen rekommendation ännu',
      noMutation: 'Ingen ändring kopplad',
      noResult: 'Inget resultat ännu',
      noReason: 'AI väntar på mer data.',
      noNext: 'AI väntar på mer data.',
      noDuration: 'Varaktighet saknas',
      noStepData: 'Ingen detaljerad data för steget ännu.',
      noParameterChanges: 'Inga parameterändringar kopplade.',
      noGenerationHistory: 'Ingen generationshistorik kopplad.',
      noStrategyLife: 'Ingen strategihistorik kopplad.',
      sourceMissing: 'Källan svarar inte just nu.',
      reused: 'Återanvänt resultat',
      registered: 'Registrerat test',
      completed: 'Klar',
      waiting: 'Väntar',
      failed: 'Misslyckades',
      active: 'Körs',
      skipped: 'Hoppades över',
      found: 'Finns',
      missing: 'Saknas',
      currentDecision: 'Aktuellt beslut',
      replayCompleted: 'Test klart',
      replayQueued: 'Test planerat',
      replayRunning: 'Test körs',
      replayFailed: 'Test misslyckades',
      learningRecorded: 'Lärdom sparad',
      memoryRegistered: 'Tidigare test registrerat',
      recommendationFromBrain: 'AI rekommenderar test',
      recommendationFromDirector: 'Nästa steg rekommenderat',
      mutationCreated: 'Ändring skapad',
      libraryUpdated: 'Strategibiblioteket uppdaterat',
      eventRecorded: 'Beslut från händelselogg',
      auditRecorded: 'Beslut från granskningsspår',
    }),
    resultLabels: Object.freeze({
      trades: 'affärer',
      winrate: 'winrate',
      drawdown: 'drawdown',
      profitFactor: 'profit factor',
      strategyScore: 'betyg',
      generation: 'generation',
    }),
    help: Object.freeze({
      what: 'Journalen visar AI-beslut i tidsordning.',
      why: 'Den gör varje beslut spårbart från test till resultat.',
      next: 'Klicka på en rad för att se hela tidslinjen.',
    }),
  }),
  factoryExplorer: Object.freeze({
    readOnly: 'Läsvy',
    refreshButton: 'Uppdatera',
    emptyValue: '—',
    labels: Object.freeze({
      status: 'Status',
      total: 'Antal',
      latest: 'Senaste',
      strategy: SV_TERMS[FACTORY_TERM_KEYS.STRATEGY].displayName,
      market: 'Marknad',
      result: 'Resultat',
      generation: 'Generation',
      branch: 'Gren',
      version: 'Version',
      lifecycle: 'Livscykel',
      source: 'Källa',
      details: 'Detaljer',
      selected: 'Valt objekt',
      replay: 'Historiskt test',
      periods: 'Perioder',
      branches: 'Grenar',
      nodes: 'Versioner',
      strategies: 'Strategier',
    }),
    states: Object.freeze({
      loading: 'Hämtar data',
      empty: 'Ingen data ännu.',
      noStrategy: 'Ingen strategi vald',
      noMarket: 'Ingen marknad vald',
      noResult: 'Inget resultat ännu',
      noGeneration: 'Ingen generation kopplad',
      noSelection: 'Välj en rad för detaljer.',
      complete: 'Klar',
      waiting: 'Väntar',
      missing: 'Saknas',
    }),
    libraryProduct: Object.freeze({
      title: SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_LIBRARY].displayName,
      subtitle: 'Ett bibliotek för strategier: vad som ser lovande ut, vad som behöver testas och vad som kan gå vidare.',
      readOnly: 'Läsvy',
      emptyValue: '—',
      sections: Object.freeze({
        overview: Object.freeze({
          title: 'Strategiöversikt',
          summary: 'Visar var strategierna befinner sig utan tekniska nycklar eller interna mätvärden.',
        }),
        attention: Object.freeze({
          title: 'Strategier som behöver uppmärksamhet',
          summary: 'De viktigaste strategierna att titta på först.',
        }),
        all: Object.freeze({
          title: 'Alla strategier',
          summary: 'Kort för varje strategi i biblioteket.',
        }),
        detail: Object.freeze({
          title: 'Strategidetalj',
          summary: 'Samlar vad strategin gör, hur den har utvecklats och vad som bör hända härnäst.',
        }),
        lifecycle: Object.freeze({
          title: 'Strategins väg',
          summary: 'En enkel bild av var strategin befinner sig.',
        }),
      }),
      labels: Object.freeze({
        total: 'Totalt antal strategier',
        draft: SV_TERMS[FACTORY_TERM_KEYS.DRAFT].displayName,
        testing: SV_TERMS[FACTORY_TERM_KEYS.TESTING].displayName,
        readyForPaper: SV_TERMS[FACTORY_TERM_KEYS.CANDIDATE].displayName,
        live: SV_TERMS[FACTORY_TERM_KEYS.LIVE].displayName,
        retired: 'Pensionerade',
        name: 'Namn',
        status: 'Status',
        latestResult: 'Senaste resultat',
        nextStep: 'Nästa steg',
        what: 'Vad strategin gör',
        development: 'Hur den har utvecklats',
        tests: 'Historiska tester',
        markets: 'Marknadstyper',
        learnings: 'Lärdomar',
        result: 'Resultat',
        version: 'Version',
        updated: 'Uppdaterad',
      }),
      states: Object.freeze({
        noStrategies: 'Inga strategier i biblioteket ännu.',
        noAttention: 'Inget kräver uppmärksamhet just nu.',
        noSelection: 'Välj en strategi för att se hela bilden.',
        noResult: 'Inget resultat ännu',
        noMarket: 'Ingen marknadstyp bekräftad',
        noDevelopment: 'Ingen versionshistorik ännu',
        noLearning: 'Inga lärdomar ännu',
        noVersion: 'Ingen version ännu',
      }),
      attention: Object.freeze({
        needsTests: 'Behöver fler tester',
        waitingReview: 'Väntar på godkännande',
        readyForPaper: SV_TERMS[FACTORY_TERM_KEYS.CANDIDATE].displayName,
        weakResults: 'Svaga resultat',
        canRetire: 'Kan arkiveras',
      }),
      nextSteps: Object.freeze({
        runTests: 'Kör fler historiska tester',
        reviewPaper: 'Granska för Paper Trading',
        improve: 'Förbättra strategin',
        watchPaper: 'Följ Paper Trading',
        watchLive: 'Följ Live Trading',
        archive: 'Kan arkiveras',
        wait: 'Vänta på mer data',
      }),
      lifecycle: Object.freeze({
        idea: 'Idé',
        test: 'Test',
        paper: SV_TERMS[FACTORY_TERM_KEYS.PAPER].displayName,
        live: SV_TERMS[FACTORY_TERM_KEYS.LIVE].displayName,
        retired: 'Pensionerad',
      }),
      descriptions: Object.freeze({
        momentum: 'Följer stark rörelse och söker fortsättning.',
        vwap: 'Jämför priset med volymens jämviktsnivå.',
        breakout: 'Söker utbrott när priset lämnar ett tidigare område.',
        reversal: 'Söker återgång efter en överdriven rörelse.',
        default: 'En sparad strategi med testhistorik och nästa rekommenderade steg.',
      }),
    }),
    historicalTestsProduct: Object.freeze({
      title: 'Historiska tester',
      subtitle: 'En testhistorik som visar vad som har körts, vad som pågår, resultatet och vad AI lärde sig.',
      readOnly: 'Läsvy',
      emptyValue: '—',
      sections: Object.freeze({
        overview: Object.freeze({
          title: 'Historiska tester',
          summary: 'Snabb lägesbild över tester som väntar, körs, är klara eller har misslyckats.',
        }),
        latest: Object.freeze({
          title: 'Senaste tester',
          summary: 'De senaste testkörningarna med resultat, lärdom och nästa steg.',
        }),
        active: Object.freeze({
          title: 'Pågående tester',
          summary: 'Visar bara tester som väntar eller körs just nu.',
        }),
        detail: Object.freeze({
          title: 'Testdetaljer',
          summary: 'Välj ett test för att se vad som testades, varför, resultatet och rekommenderat nästa steg.',
        }),
      }),
      labels: Object.freeze({
        running: 'Pågår',
        waiting: 'Väntar',
        completed: 'Klara',
        failed: 'Misslyckade',
        strategy: SV_TERMS[FACTORY_TERM_KEYS.STRATEGY].displayName,
        market: SV_TERMS[FACTORY_TERM_KEYS.MARKET_DNA].displayName,
        ranAt: 'När testet kördes',
        result: 'Resultat',
        learning: 'Lärdom',
        nextStep: 'Nästa steg',
        tested: 'Vad testades',
        why: 'Varför testades det',
        status: 'Status',
        trades: 'Affärer',
      }),
      states: Object.freeze({
        noTests: 'Inga historiska tester har körts ännu.',
        noActive: 'Inga tester pågår just nu.',
        noSelection: 'Välj ett test för att se detaljer.',
        noStrategy: 'Ingen strategi vald',
        noMarket: 'Ingen marknadstyp bekräftad',
        noResult: 'Inget resultat ännu',
        noLearning: 'Ingen lärdom sparad ännu',
        noReason: 'AI behövde mer kunskap om strategin.',
        waiting: SV_STATUS[FACTORY_STATUS_KEYS.WAITING],
        running: SV_STATUS[FACTORY_STATUS_KEYS.RUNNING],
        completed: SV_STATUS[FACTORY_STATUS_KEYS.COMPLETED],
        failed: SV_STATUS[FACTORY_STATUS_KEYS.FAILED],
      }),
      outcomes: Object.freeze({
        strong: 'Strategin fungerade bra i den här marknadstypen.',
        weak: 'Strategin var svag i den här marknadstypen.',
        mixed: 'Resultatet var blandat och behöver mer underlag.',
        noTrades: 'Testet gav inga affärer.',
        waiting: 'AI väntar på att testet blir klart.',
      }),
      nextSteps: Object.freeze({
        wait: 'Vänta tills testet är klart',
        readResult: 'Granska resultatet',
        learn: 'Spara lärdom',
        runMore: 'Kör fler historiska tester',
        improve: 'Förbättra strategin',
        reviewPaper: 'Granska för Paper Trading',
        done: 'Inget nytt steg behövs',
      }),
    }),
    modes: Object.freeze({
      library: Object.freeze({
        title: SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_LIBRARY].displayName,
        subtitle: 'Läsvy över strategiernas liv, resultat och senaste händelser.',
        summary: 'Strategibiblioteket visar sparade resultat och livscykel.',
      }),
      replay: Object.freeze({
        title: 'Tester',
        subtitle: 'Utforska historiska tester och testhändelser.',
        summary: 'Här granskas tidigare tester och deras händelser.',
      }),
      family: Object.freeze({
        title: SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_FAMILY_TREE].displayName,
        subtitle: 'Läsvy över generationer, ändringar och grenar.',
        summary: 'Strategiträdet visar hur versioner hör ihop.',
      }),
      market: Object.freeze({
        title: SV_TERMS[FACTORY_TERM_KEYS.MARKET_DNA].displayName,
        subtitle: 'Läsvy över marknadstyper som historiska tester använder.',
        summary: 'Marknadstypen visar vilken marknad ett resultat kommer från.',
      }),
    }),
  }),
  strategyBrainPanel: Object.freeze({
    titles: Object.freeze({
      loading: 'Kunskapsanalys',
      error: 'Kunskapsanalys',
      strategy: 'Kunskapsläge och rekommendation',
      system: 'Vad AI saknar',
    }),
    labels: Object.freeze({
      recommendation: 'Rekommendation',
      knowledgeScore: 'Kunskapspoäng',
      confidence: 'Säkerhet',
      coverage: 'Täckning',
      nextReplay: 'Nästa test',
      targetRegime: SV_TERMS[FACTORY_TERM_KEYS.MARKET_DNA].displayName,
      marketRegimes: 'Marknadstyper',
      aiMemory: SV_TERMS[FACTORY_TERM_KEYS.AI_MEMORY].displayName,
    }),
    messages: Object.freeze({
      loading: 'Analyserar vad som saknas.',
      errorPrefix: 'Analysen kunde inte hämtas',
      errorUnknown: 'okänt fel',
      errorSuffix: 'Vänta tills systemet har uppdaterats och försök igen.',
      noReplay: 'Inget att köra',
      noRegime: 'Ingen marknadstyp ännu',
      allKnown: 'Alla tidigare tester är redan kända.',
      noRepeats: 'Inga upprepade tester',
      repeatsWarning: 'upprepade tester hittades',
      allRegimesTried: 'Alla marknadstyper är prövade',
      everyRegimeSeen: 'Varje marknadstyp är prövad av minst en strategi',
      of: 'av',
    }),
    hints: Object.freeze({
      knowledgeScore: 'Hur mycket vi vet. 100 betyder att inga viktiga tester saknas.',
      confidence: 'Skilt från strategins betyg.',
      informationValue: 'Informationsvärde',
      noStrategyHasSeen: 'Ingen strategi har sett',
    }),
  }),
  strategyLifecyclePanel: Object.freeze({
    title: 'Livscykel och förtroende',
    labels: Object.freeze({
      lifecycle: 'Livscykel',
      confidence: 'Säkerhet',
      promotion: 'Nästa steg',
      retirement: 'Arkivering',
      strategyScore: 'Strategibetyg',
      executionScore: 'Utförandebetyg',
      productionScore: 'Produktionsbetyg',
      history: SV_TERMS[FACTORY_TERM_KEYS.HISTORY].displayName,
      marketRegimes: 'Marknadstyper',
    }),
    promotionLabels: Object.freeze({
      ready: 'Klar för nästa steg',
      blocked: 'Blockerad',
      terminal: 'Sista steget',
      retired: SV_TERMS[FACTORY_TERM_KEYS.RETIRED].displayName,
      not_in_library: 'Saknas i strategibiblioteket',
    }),
    retirementLabels: Object.freeze({
      active: 'Aktiv',
      suggested: 'Arkivering föreslås',
      retired: SV_TERMS[FACTORY_TERM_KEYS.RETIRED].displayName,
      unknown: '—',
    }),
    messages: Object.freeze({
      step: 'Steg',
      of: 'av',
      nextStep: 'Nästa steg',
      confidenceHint: 'Hur mycket vi vet. Skilt från strategins betyg.',
      strategyScoreHint: 'Historiskt test av strategins logik.',
      executionScoreHint: 'Vad utförandet kostade.',
      productionScoreHint: 'Paper och live över tid.',
      tooFewPaperTrades: 'För få Paper Trading-affärer för att luta sig mot',
      marketDnaPrefix: SV_TERMS[FACTORY_TERM_KEYS.MARKET_DNA].displayName,
      replayCount: 'historiska test',
      paperCount: SV_TERMS[FACTORY_TERM_KEYS.PAPER_TRADING].displayName,
      liveCount: SV_TERMS[FACTORY_TERM_KEYS.LIVE].displayName,
      noHistory: 'Ingen ännu',
      tried: 'prövade',
      blindSpotsInMarketIntelligence: 'otestade marknader visas i marknadsläget',
      neverReplayTested: 'Strategin har aldrig körts i historiskt test.',
    }),
  }),
  strategyRuntimePanel: Object.freeze({
    title: SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_RUNTIME].displayName,
    labels: Object.freeze({
      runtimeState: 'Motorläge',
      runtimeStatus: 'Motorstatus',
      currentCandidate: SV_TERMS[FACTORY_TERM_KEYS.CANDIDATE].displayName,
      entryReady: 'Redo att agera',
      canonicalVerdict: 'Samlat beslut',
      reasonCode: 'Orsak',
      marketRegime: SV_TERMS[FACTORY_TERM_KEYS.MARKET_DNA].displayName,
      dataSource: 'Datakälla',
      updated: 'Uppdaterad',
    }),
  }),
  futuresRuntimeDiagnostic: Object.freeze({
    eyebrow: 'Driftläge',
    title: 'Marknadsbevakning',
    summary: 'Visar vägval, stopporsaker och marknadsbevakningens räknare. Det som följs just nu visas i handelsbordet.',
  }),
  contextNavigation: Object.freeze({
    ariaLabel: 'Fortsätt i arbetsflödet',
    eyebrow: 'Nästa steg',
    title: 'Fortsätt härifrån',
    summary: 'Öppna nästa relevanta vy utan att använda sidomenyn.',
    fallbackSummary: 'Länken fungerar även när detaljdata saknas.',
    actions: Object.freeze({
      factory: Object.freeze({
        label: 'Tillbaka till AI Fabriken',
        description: 'Se vad AI gör just nu och vad som händer härnäst.',
        tone: 'neutral',
      }),
      factoryWork: Object.freeze({
        label: 'Visa arbetsflöde',
        description: 'Se import, tester, lärdomar och nästa steg i samma kedja.',
        tone: 'info',
      }),
      strategy: Object.freeze({
        label: 'Öppna strategi',
        description: 'Visa strategins liv, resultat och nästa rekommenderade steg.',
        tone: 'info',
      }),
      test: Object.freeze({
        label: 'Visa test',
        description: 'Öppna testhistoriken för valt test eller vald strategi.',
        tone: 'info',
      }),
      decision: Object.freeze({
        label: 'Visa beslut',
        description: 'Se varför AI tog beslutet och vad som händer efteråt.',
        tone: 'warning',
      }),
      paper: Object.freeze({
        label: 'Öppna Paper Trading',
        description: 'Följ dagens läge, öppna positioner och senaste avslut.',
        tone: 'success',
      }),
      approval: Object.freeze({
        label: 'Granska godkännande',
        description: 'Öppna den plats där strategier granskas före Paper Trading.',
        tone: 'warning',
      }),
      result: Object.freeze({
        label: 'Granska resultat',
        description: 'Se resultatet i testhistoriken och hur AI tolkar det.',
        tone: 'success',
      }),
      market: Object.freeze({
        label: 'Visa marknad',
        description: 'Öppna marknadsläget som testet eller strategin hör till.',
        tone: 'neutral',
      }),
    }),
  }),
  futuresPaperDesk: Object.freeze({
    title: 'Handelstest',
    subtitle: 'Ett handelsbord för paper trading: dagens läge, strategier, resultat och det som kräver din uppmärksamhet.',
    safetyCopy: 'Handelstest använder IBKR Paper Trading. Inga riktiga pengar används och riktiga konton är blockerade.',
    tabs: Object.freeze({
      today: 'Dagens läge',
      positions: 'Öppna positioner',
      recentTrades: 'Senaste avslut',
      approval: 'Godkännande',
    }),
    states: Object.freeze({
      active: 'Paper Trading aktivt',
      trading: 'AI handlar',
      waiting: 'AI väntar',
      approval: 'Väntar på godkännande',
      noPositions: 'Inga positioner',
      loading: 'Hämtar data',
      problem: 'Problem',
      normal: 'Allt normalt',
      noResultYet: 'Inget resultat ännu',
      noClosedTrades: 'Inga avslut ännu',
      noOpenPositions: 'Inga öppna positioner.',
      noAction: 'Ingen åtgärd krävs',
    }),
    sections: Object.freeze({
      daily: Object.freeze({
        eyebrow: 'Handelsbord',
        title: 'Dagens läge',
        summary: 'Svarar snabbt på om AI handlar, hur dagen går och om något kräver dig.',
        status: 'Läge',
        result: 'Dagens resultat',
        positions: 'Öppna positioner',
        normality: 'Är allt normalt?',
        why: 'Varför',
        next: 'Nästa steg',
      }),
      positions: Object.freeze({
        eyebrow: 'Öppna positioner',
        title: 'Det som är ute i marknaden',
        summary: 'Visar bara positioner som fortfarande är öppna.',
        open: 'Visa alla positioner',
        noRows: 'Inga öppna positioner.',
      }),
      recentTrades: Object.freeze({
        eyebrow: 'Senaste avslut',
        title: 'Senaste affärerna',
        summary: 'Kort översikt över de senaste avslutade affärerna.',
        open: 'Visa alla avslut',
        noRows: 'Inga avslut ännu.',
      }),
      needsYou: Object.freeze({
        eyebrow: 'Behöver dig',
        title: 'En sak att ta ställning till',
        summary: 'Visar bara den viktigaste uppgiften just nu.',
        priority: 'Prioritet',
        why: 'Varför',
      }),
      strategies: Object.freeze({
        eyebrow: 'Strategier',
        title: 'Dagens strategier',
        summary: 'Visar vilka strategier som går bäst, testas nu, är redo för Paper Trading eller behöver mer uppmärksamhet.',
        categories: Object.freeze({
          bestToday: Object.freeze({
            title: '🏆 Bäst idag',
            empty: 'Inga resultat ännu.',
          }),
          testingNow: Object.freeze({
            title: '🔥 AI testar nu',
            empty: 'AI har inte testat denna strategi ännu.',
          }),
          readyForPaper: Object.freeze({
            title: '⭐ Redo för Paper',
            empty: 'Inga strategier redo ännu.',
          }),
          needsAttention: Object.freeze({
            title: '⚠ Behöver uppmärksamhet',
            empty: 'Inga strategier behöver uppmärksamhet just nu.',
          }),
        }),
        labels: Object.freeze({
          result: 'Resultat',
          next: 'Nästa steg',
          market: 'Marknadstyp',
          status: 'Status',
          openStrategy: 'Öppna strategi',
        }),
      }),
      leaderboards: Object.freeze({
        eyebrow: 'Topplistor',
        title: 'Mest lovande strategier',
        summary: 'Snabba listor över det som presterar bäst just nu.',
        bestResult: 'Bäst resultat',
        highestWinRate: 'Högst vinstprocent',
        biggestImprovement: 'Störst förbättring',
        mostPromising: 'Mest lovande strategi',
        empty: 'Inga resultat ännu.',
      }),
      broker: Object.freeze({
        eyebrow: 'Brokerstatus',
        title: 'Kopplingen till paperkontot',
        summary: 'Förenklad status för broker, data och avstämning.',
        connection: 'Broker',
        data: 'Marknadsdata',
        orders: 'Orderläge',
        check: 'Avstämning',
        technical: 'Visa teknisk information',
      }),
    }),
    actions: Object.freeze({
      approve: Object.freeze({
        title: 'Godkänn strategi',
        explanation: 'En strategi väntar på granskning innan den får följas i Paper Trading.',
        why: 'Paper Trading startar inte för strategin förrän den är godkänd.',
        priority: 'Hög',
        button: 'Öppna godkännande',
      }),
      checkResults: Object.freeze({
        title: 'Kontrollera resultat',
        explanation: 'Minst en affär behöver granskas innan resultatet kan tolkas säkert.',
        why: 'Affären saknar verifierat resultat, saknar skydd eller stoppades av broker.',
        priority: 'Hög',
        button: 'Öppna senaste avslut',
      }),
      checkBroker: Object.freeze({
        title: 'Kontrollera brokerstatus',
        explanation: 'Paperkontot eller datakopplingen behöver uppmärksamhet.',
        why: 'Handelsbordet behöver en frisk brokerkoppling för att visa säkert läge.',
        priority: 'Hög',
        button: 'Visa teknisk information',
      }),
      noAction: Object.freeze({
        title: 'Ingen åtgärd krävs',
        explanation: 'AI arbetar vidare eller väntar utan att du behöver göra något.',
        why: 'Det finns inget godkännande, ingen varning och inget resultat som kräver manuell kontroll.',
        priority: 'Normal',
        button: 'Se dagens läge',
      }),
    }),
    brokerStates: Object.freeze({
      connected: 'Ansluten',
      loading: 'Hämtar data',
      waiting: 'Väntar',
      problem: 'Problem',
      protected: 'Skyddat',
    }),
    labels: Object.freeze({
      strategy: 'Strategi',
      market: 'Marknad',
      result: 'Resultat',
      status: 'Status',
      time: 'Tid',
      quantity: 'Antal',
      direction: 'Riktning',
      updated: 'Uppdaterad',
    }),
  }),
  quickHelp: Object.freeze({
    ariaLabel: 'Så fungerar Trading OS',
    closeHelp: 'Stäng hjälp',
    kicker: 'Ny här?',
    title: 'Så fungerar Trading OS',
    lead: 'Systemet letar efter signaler, testar idéer säkert och hjälper dig förstå vad som verkar bra, svagt eller stoppat.',
    notes: Object.freeze([
      'Grön = ser bra ut',
      'Gul = behöver mer data',
      'Röd = stoppad eller kräver försiktighet',
    ]),
    safety: 'Inga riktiga affärer görs automatiskt. Du bestämmer vad som ska granskas.',
  }),
  glossary: Object.freeze({
    ariaLabel: 'Snabb förklaring av viktiga ord',
  }),
});

export const UI_TERMINOLOGY = Object.freeze({
  sv: Object.freeze({
    terms: SV_TERMS,
    statuses: SV_STATUS,
    lifecycle: SV_LIFECYCLE,
    actions: SV_ACTIONS,
    gaps: SV_GAPS,
    factoryDecisions: SV_FACTORY_DECISIONS,
    factoryReasons: SV_FACTORY_REASONS,
    copy: SV_COPY,
  }),
});

const TECHNICAL_TEXT_REPLACEMENTS = Object.freeze([
  ['ReplayQueueService', SV_TERMS[FACTORY_TERM_KEYS.REPLAY_QUEUE].displayName],
  ['FactoryDirectorService', SV_TERMS[FACTORY_TERM_KEYS.FACTORY_DIRECTOR].displayName],
  ['StrategyRuntimeService', SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_RUNTIME].displayName],
  ['Factory Director', SV_TERMS[FACTORY_TERM_KEYS.FACTORY_DIRECTOR].displayName],
  ['FactoryDirector', SV_TERMS[FACTORY_TERM_KEYS.FACTORY_DIRECTOR].displayName],
  ['Strategy Brain', SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_BRAIN].displayName],
  ['StrategyBrain', SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_BRAIN].displayName],
  ['AI Memory', SV_TERMS[FACTORY_TERM_KEYS.AI_MEMORY].displayName],
  ['AIMemory', SV_TERMS[FACTORY_TERM_KEYS.AI_MEMORY].displayName],
  ['Replay Queue', SV_TERMS[FACTORY_TERM_KEYS.REPLAY_QUEUE].displayName],
  ['ReplayQueue', SV_TERMS[FACTORY_TERM_KEYS.REPLAY_QUEUE].displayName],
  ['Replay Scheduler', SV_TERMS[FACTORY_TERM_KEYS.REPLAY_SCHEDULER].displayName],
  ['ReplayScheduler', SV_TERMS[FACTORY_TERM_KEYS.REPLAY_SCHEDULER].displayName],
  ['Replay Engine', SV_TERMS[FACTORY_TERM_KEYS.REPLAY_ENGINE].displayName],
  ['ReplayEngine', SV_TERMS[FACTORY_TERM_KEYS.REPLAY_ENGINE].displayName],
  ['Historical Backfill', SV_TERMS[FACTORY_TERM_KEYS.HISTORICAL_BACKFILL].displayName],
  ['HistoricalBackfill', SV_TERMS[FACTORY_TERM_KEYS.HISTORICAL_BACKFILL].displayName],
  ['Historical PriceFeed', SV_TERMS[FACTORY_TERM_KEYS.HISTORICAL_PRICE_FEED].displayName],
  ['HistoricalPriceFeed', SV_TERMS[FACTORY_TERM_KEYS.HISTORICAL_PRICE_FEED].displayName],
  ['Strategy Runtime', SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_RUNTIME].displayName],
  ['StrategyRuntime', SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_RUNTIME].displayName],
  ['Strategy Library', SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_LIBRARY].displayName],
  ['StrategyLibrary', SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_LIBRARY].displayName],
  ['Strategy DNA', SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_DNA].displayName],
  ['StrategyDNA', SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_DNA].displayName],
  ['Market DNA', SV_TERMS[FACTORY_TERM_KEYS.MARKET_DNA].displayName],
  ['MarketDNA', SV_TERMS[FACTORY_TERM_KEYS.MARKET_DNA].displayName],
  ['AI Optimizer', SV_TERMS[FACTORY_TERM_KEYS.AI_OPTIMIZER].displayName],
  ['AIOptimizer', SV_TERMS[FACTORY_TERM_KEYS.AI_OPTIMIZER].displayName],
  ['Evolution Engine', SV_TERMS[FACTORY_TERM_KEYS.EVOLUTION_ENGINE].displayName],
  ['EvolutionEngine', SV_TERMS[FACTORY_TERM_KEYS.EVOLUTION_ENGINE].displayName],
  ['Strategy Family Tree', SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_FAMILY_TREE].displayName],
  ['StrategyFamilyTree', SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_FAMILY_TREE].displayName],
  ['Experiment Registry', 'Testregister'],
  ['ExperimentRegistry', 'Testregister'],
  ['Replay Session', 'Historiskt test'],
  ['ReplaySession', 'Historiskt test'],
  ['Replay Run', 'Historiskt test'],
  ['ReplayRun', 'Historiskt test'],
  ['Replay', 'Historiskt test'],
  ['replay', 'historiskt test'],
  ['Batch', SV_TERMS[FACTORY_TERM_KEYS.BATCH].displayName],
  ['batch', 'många tester'],
  ['ibkr_paper', 'IBKR Paper'],
  ['ibkr_live', 'IBKR Live'],
  ['simulated_fallback', 'Arkiverad simulering'],
  ['internal_legacy_simulation', 'Arkiverad simulering'],
  ['Execution', 'Orderhantering'],
  ['execution', 'orderhantering'],
  ['candidateDnaHash', SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_DNA].displayName],
  ['candidate_dna_hash', SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_DNA].displayName],
  ['libraryRunId', 'Resultatreferens'],
  ['library_run_id', 'Resultatreferens'],
  ['Runtime', SV_TERMS[FACTORY_TERM_KEYS.STRATEGY_RUNTIME].displayName],
  ['runtime', 'strategimotor'],
]);

function escapePattern(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dictionary(language = DEFAULT_UI_LANGUAGE) {
  return UI_TERMINOLOGY[language] || UI_TERMINOLOGY[DEFAULT_UI_LANGUAGE];
}

export function uiTerm(key, language = DEFAULT_UI_LANGUAGE) {
  return dictionary(language).terms[key] || {
    codeName: key,
    displayName: key,
    description: '',
    why: '',
    expectedAction: '',
  };
}

export function uiName(key, language = DEFAULT_UI_LANGUAGE) {
  return uiTerm(key, language).displayName;
}

export function uiDescription(key, language = DEFAULT_UI_LANGUAGE) {
  return uiTerm(key, language).description;
}

export function uiPanelText(key, language = DEFAULT_UI_LANGUAGE) {
  const term = uiTerm(key, language);
  return {
    title: term.displayName,
    description: term.description,
    why: term.why,
    expectedAction: term.expectedAction,
  };
}

export function uiCopy(section, language = DEFAULT_UI_LANGUAGE) {
  return dictionary(language).copy[section] || {};
}

export function uiPanelHelpItems(key, language = DEFAULT_UI_LANGUAGE) {
  const labels = uiCopy('panelHelpLabels', language);
  const text = uiPanelText(key, language);
  return [
    { label: labels.description, value: text.description },
    { label: labels.why, value: text.why },
    { label: labels.expectedAction, value: text.expectedAction },
  ].filter((item) => item.value);
}

export function uiStatus(status, language = DEFAULT_UI_LANGUAGE) {
  const normalized = String(status || '').trim().toLowerCase();
  return dictionary(language).statuses[normalized] || status || '';
}

export function uiLifecycleStage(stage, language = DEFAULT_UI_LANGUAGE) {
  const normalized = String(stage || '').trim().toLowerCase();
  return dictionary(language).lifecycle[normalized] || stage || '';
}

export function uiFactoryAction(action, language = DEFAULT_UI_LANGUAGE) {
  const normalized = String(action || '').trim();
  return dictionary(language).actions[normalized] || action || '';
}

export function uiFactoryGap(gap, language = DEFAULT_UI_LANGUAGE) {
  const normalized = String(gap || '').trim();
  return dictionary(language).gaps[normalized] || gap || '';
}

export function uiHelpCard(key, language = DEFAULT_UI_LANGUAGE) {
  const term = uiTerm(key, language);
  return {
    title: term.displayName,
    text: term.description,
    why: term.why,
    expectedAction: term.expectedAction,
  };
}

export function uiHelpCards(keys, language = DEFAULT_UI_LANGUAGE) {
  return keys.map((key) => uiHelpCard(key, language));
}

export function uiFactoryDashboard(language = DEFAULT_UI_LANGUAGE) {
  return dictionary(language).copy.factoryDashboard || {};
}

export function uiDecisionJournal(language = DEFAULT_UI_LANGUAGE) {
  return dictionary(language).copy.aiDecisionJournal || {};
}

export function uiFactoryFlowNavigation(language = DEFAULT_UI_LANGUAGE) {
  return dictionary(language).copy.factoryFlowNavigation || {};
}

export function uiFactoryExplorer(language = DEFAULT_UI_LANGUAGE) {
  return dictionary(language).copy.factoryExplorer || {};
}

export function uiFactoryDashboardPanel(panelKey, language = DEFAULT_UI_LANGUAGE) {
  const dashboard = uiFactoryDashboard(language);
  return (dashboard.panels && dashboard.panels[panelKey]) || {
    icon: '',
    title: panelKey,
    description: '',
    why: '',
    next: '',
  };
}

export function uiFactoryDecision(action, language = DEFAULT_UI_LANGUAGE) {
  const normalized = String(action || '').trim();
  return dictionary(language).factoryDecisions[normalized] || dictionary(language).factoryDecisions.IDLE;
}

export function uiFactoryReason(reason, language = DEFAULT_UI_LANGUAGE) {
  const normalized = String(reason || '').trim();
  if (!normalized) return dictionary(language).factoryDecisions.IDLE.description;
  if (dictionary(language).factoryReasons[normalized]) return dictionary(language).factoryReasons[normalized];
  if (/^[a-z0-9_:-]+$/i.test(normalized)) return uiFactoryDashboard(language).states.genericReason;
  return uiFactorySafeText(normalized, language);
}

// Interna strategi-id är byggda för kod: `native_futures_vwap_reclaim_v1`.
// Användaren ska se ett namn, inte en nyckel. Prefixet säger var strategin är
// implementerad och versionssuffixet säger vilken kodgeneration det är — båda
// är utvecklarinformation och tas bort. Kvar blir det som faktiskt namnger
// strategin. Kända förkortningar sätts versalt så att de läses som ord.
const STRATEGY_ID_PREFIXES = Object.freeze([
  'native_futures_',
  'futures_',
  'strategy_',
]);
const STRATEGY_ACRONYMS = Object.freeze(['vwap', 'ema', 'atr', 'rsi', 'mnq', 'mes', 'ib', 'ai']);

export function uiStrategyName(value, fallback = '') {
  if (value != null && typeof value === 'object') return fallback;
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return fallback;
  // Ett namn som redan innehåller mellanslag är skrivet för människor.
  if (/\s/.test(raw)) return raw;

  let name = raw;
  for (const prefix of STRATEGY_ID_PREFIXES) {
    if (name.toLowerCase().startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  }
  name = name.replace(/_v\d+$/i, '');
  const words = name.split(/[_-]+/).filter(Boolean);
  if (!words.length) return fallback || raw;

  return words
    .map((word, index) => {
      if (STRATEGY_ACRONYMS.includes(word.toLowerCase())) return word.toUpperCase();
      if (index === 0) return word.charAt(0).toUpperCase() + word.slice(1);
      return word;
    })
    .join(' ');
}

export function uiFactorySafeText(value, language = DEFAULT_UI_LANGUAGE) {
  if (value == null || value === '') return '';
  if (typeof value === 'object') return '';
  let output = String(value);
  for (const [technical, display] of TECHNICAL_TEXT_REPLACEMENTS) {
    output = output.replace(new RegExp(escapePattern(technical), 'g'), display);
  }
  output = output.replace(/_/g, ' ');
  const dashboard = uiFactoryDashboard(language);
  return output.trim() || dashboard.emptyValue || '';
}
