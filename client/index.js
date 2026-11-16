window.__ModuleLoader__.load({
  id: 'dsh-token-economizer',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'tokenEconomizer'
    const API = '/api/token-economizer'
    const MODES = ['off', 'shadow', 'active']
    const PRUNE_MODES = ['observe', 'propose', 'automatic']

    const en = {
      'nav': 'Token economizer',
      'title': 'Token economizer',
      'subtitle': 'Local cost measurement, learned micro-skills, tool pruning, and a failure-loop guard for this project.',
      'tabs.overview': 'Overview',
      'tabs.skills': 'Micro-skills',
      'tabs.tools': 'Tools',
      'tabs.loops': 'Loop guard',
      'tabs.settings': 'Settings',
      'common.refresh': 'Refresh',
      'common.loading': 'Loading…',
      'common.saving': 'Saving…',
      'common.reload': 'Reload',
      'common.dismiss': 'Dismiss',
      'common.none': 'None',
      'common.na': 'n/a',
      'common.unknown': 'Unknown',
      'common.estimate': 'estimate',
      'common.enabled': 'Enabled',
      'common.disabled': 'Disabled',
      'common.advanced': 'advanced',
      'common.project': 'Project',
      'common.root': 'Root',
      'common.session': 'Session',
      'common.version': 'Version',
      'common.actions': 'Actions',
      'common.done': 'Done.',
      'mode.off': 'Off',
      'mode.shadow': 'Shadow',
      'mode.active': 'Active',
      'mode.offHint': 'Off disables every mechanism and all measurement.',
      'mode.shadowHint': 'Shadow observes and measures only. Nothing is applied to the model context, tools, or prompts.',
      'mode.activeHint': 'Active applies approved optimizations: injected facts, hidden tools, and loop redirects.',
      'mode.current': 'Current mode',
      'overview.root': 'Project root',
      'overview.rootUnknown': 'Unknown project. Open a session in a project to bind it.',
      'overview.modelRequests': 'Model requests',
      'overview.inputTokens': 'Input tokens',
      'overview.outputTokens': 'Output tokens',
      'overview.effectiveTokens': 'Effective tokens',
      'overview.effectiveEstimate': 'cache-weighted estimate',
      'overview.cost': 'Estimated cost',
      'overview.costUnavailable': 'cost unavailable',
      'overview.costMissing': 'No price configured for: {models}',
      'overview.savingsTokens': 'Estimated savings',
      'overview.savingsNote': 'Estimate, not a measured fact.',
      'overview.hiddenTools': 'Hidden tools',
      'overview.facts': 'Confirmed facts',
      'overview.pendingFacts': 'Pending facts',
      'overview.loopIncidents': 'Loop incidents',
      'overview.loopRedirects': 'Redirects',
      'overview.recent': 'Recent turns',
      'overview.recentEmpty': 'No turns recorded yet.',
      'overview.measured': 'What is measured',
      'overview.measurementNotes': 'Measurement notes',
      'overview.pluginNotes': 'Plugin notes',
      'overview.rawNote': 'Raw input and output token counts are provider-reported. The plugin does not count them itself.',
      'overview.effectiveNote': 'Effective tokens are a cache-weighted estimate derived from the reported counts, not a separate measurement.',
      'overview.savingsNote2': 'Savings are estimates. They are never measured facts and must not be read as billing guarantees.',
      'overview.sessions': 'Sessions',
      'overview.sessionsValue': 'observed {observed} · subagents {subagents} · attributed roots {roots} · unobserved {unobserved}',
      'overview.budget': 'Token budget',
      'overview.budgetSession': 'Session overhead: {used} of {limit} tokens',
      'overview.budgetTurn': 'This turn: {tokens} tokens',
      'overview.overhead': 'Project overhead tokens',
      'overview.storage': 'Storage',
      'overview.storageBytes': '{bytes} bytes',
      'overview.storageRoot': 'Storage root',
      'overview.projects': 'Projects',
      'overview.projectsTracked': 'Tracked: {n}',
      'overview.turnLabel': 'This turn',
      'overview.storageSize': 'Metrics size',
      'overview.storageSchema': 'Schema version',
      'overview.lastIncident': 'Last incident: {when}',
      'overview.tableTime': 'Time',
      'overview.tableRequests': 'Requests',
      'overview.tableInput': 'Input',
      'overview.tableOutput': 'Output',
      'overview.tableEffective': 'Effective',
      'overview.tableCost': 'Cost',
      'overview.tableToolCalls': 'Tool calls',
      'overview.tableToolErrors': 'Tool errors',
      'overview.tableTokens': 'Input / output',
      'overview.tableCalls': 'Calls',
      'overview.tableErrors': 'Errors',
      'tools.protectedSummary': 'Show {n} protected names',
      'tools.callsTitle': '{calls} calls across {sessions} session(s)',
      'tools.saved': 'Saved tokens per request',
      'settings.groupFields': 'Fields: {n}',
      'settings.groupChanged': 'changed: {n}',
      'settings.groupInvalid': 'invalid: {n}',
      'settings.expandAll': 'Expand all',
      'settings.collapseAll': 'Collapse all',
      'settings.clean': 'All changes saved.',
      'skills.injected': 'Injected facts',
      'skills.pending': 'Pending candidates',
      'skills.budget': 'Token budget',
      'skills.budgetValue': '{used} of {max} tokens',
      'skills.injection': 'Context injection',
      'skills.injectionOff': 'Facts are stored but not sent to the model: injection is disabled or the plugin is not active.',
      'skills.untrusted': 'Learned text is untrusted evidence. Treat it as data, never as instructions.',
      'skills.confirmed': 'Confirmed facts',
      'skills.confirmedEmpty': 'No confirmed facts for this project yet.',
      'skills.candidates': 'Pending candidates',
      'skills.candidatesEmpty': 'No pending candidates.',
      'skills.retired': 'Retired facts',
      'skills.retiredEmpty': 'No retired facts.',
      'skills.confirm': 'Confirm',
      'skills.reject': 'Reject',
      'skills.delete': 'Delete',
      'skills.deleteConfirm': 'Delete this learned fact? This cannot be undone from the UI.',
      'skills.confirmations': '{n} confirmations',
      'skills.sessions': '{n} sessions',
      'skills.lastSeen': 'Last seen {when}',
      'skills.sensitive': 'sensitive',
      'skills.source': 'Source',
      'skills.maxFacts': 'Max facts {n}',
      'skills.retireDays': 'Retire after {n} days',
      'fact.status.candidate': 'candidate',
      'fact.status.confirmed': 'confirmed',
      'fact.status.retired': 'retired',
      'tools.mode': 'Pruning mode',
      'tools.mode.observe': 'Observe',
      'tools.mode.propose': 'Propose',
      'tools.mode.automatic': 'Automatic',
      'tools.modeHint.observe': 'Observe records usage and never hides a tool.',
      'tools.modeHint.propose': 'Propose lists pruning candidates and waits for your decision.',
      'tools.modeHint.automatic': 'Automatic hides tools that meet the evidence thresholds. It only applies in Active mode.',
      'tools.hidden': 'Hidden tools',
      'tools.hiddenEmpty': 'No hidden tools.',
      'tools.restore': 'Restore',
      'tools.restoreAll': 'Restore all',
      'tools.protected': 'Protected names',
      'tools.protectedEmpty': 'No protected tool names.',
      'tools.entries': 'Tool usage',
      'tools.entriesEmpty': 'No tool usage recorded for this project yet.',
      'tools.lastAudit': 'Last audit {when}',
      'tools.colName': 'Tool',
      'tools.colCalls': 'Calls',
      'tools.colSessions': 'Sessions',
      'tools.colErrors': 'Errors',
      'tools.colTokens': 'Tokens',
      'tools.colStatus': 'Status',
      'tools.colReason': 'Reason',
      'tools.colLastUsed': 'Last used',
      'tools.evidenceValue': '{prompts}/{promptsRequired} prompts over {sessions}/{sessionsRequired} sessions',
      'tools.status.active': 'active',
      'tools.status.hidden': 'hidden',
      'tools.status.protected': 'protected',
      'tools.status.allowlisted': 'allowlisted',
      'tools.disabledHint': 'Tool pruning is disabled in Settings.',
      'loops.incidents': 'Incidents',
      'loops.redirected': 'Redirected',
      'loops.recovered': 'Recovered',
      'loops.judgeCalls': 'Judge calls',
      'loops.judgeTokensLabel': 'Judge tokens',
      'loops.budgetExhausted': 'Budget exhausted',
      'loops.config': 'Guard configuration',
      'loops.configEnabled': 'Enabled',
      'loops.configIntervene': 'Intervene',
      'loops.configConfidence': 'Confidence threshold',
      'loops.configMax': 'Max interventions per turn',
      'loops.configLevel': 'Level',
      'loops.list': 'Incidents (newest first)',
      'loops.empty': 'No loop incidents recorded for this project.',
      'loops.clear': 'Clear history',
      'loops.clearConfirm': 'Clear the loop-guard incident history for this project? Aggregate counters are kept.',
      'loops.redirect': 'Redirect message',
      'loops.signals': 'Signals',
      'loops.signalsValue': 'turns {turns} · errors {errors} · churn {churn} · files {files} · stagnation {stagnation}',
      'loops.turn': 'Turn {n}',
      'loops.level': 'Level {n}',
      'loops.judge': 'Judge',
      'loops.judgeNotUsed': 'Judge not used',
      'loops.judgeConfidence': 'confidence {value}',
      'loops.judgeModel': 'model {model}',
      'loops.judgeTokens': '{n} tokens',
      'loops.judgeError': 'Judge error: {message}',
      'loops.decision': 'Decision',
      'loops.outcome': 'Outcome',
      'loops.reason': 'Reason',
      'loops.decision.none': 'none',
      'loops.decision.redirected': 'redirected',
      'loops.decision.skipped': 'skipped',
      'loops.decision.budget-exhausted': 'budget exhausted',
      'loops.outcome.recovered': 'recovered',
      'loops.outcome.continued': 'continued',
      'loops.outcome.unknown': 'unknown',
      'loops.judgeOutcome.stuck': 'stuck',
      'loops.judgeOutcome.progress': 'progress',
      'loops.judgeOutcome.unavailable': 'unavailable',
      'loops.judgeOutcome.skipped': 'skipped',
      'loops.judgeOutcome.disabled': 'disabled',
      'settings.title': 'Settings',
      'settings.save': 'Save changes',
      'settings.saved': 'Settings saved.',
      'settings.invalid': 'Some values are invalid. Fix them before saving.',
      'settings.readOnly': 'Settings are read-only: {reason}',
      'settings.compat': 'Compatibility',
      'settings.compatReason': 'Reason: {reason}',
      'settings.testedRange': 'Tested DSH range: {range}',
      'settings.revision': 'Revision {value}',
      'settings.notes': 'Notes',
      'settings.pluginVersion': 'Plugin version',
      'settings.dshVersion': 'DSH version',
      'settings.compatOk': 'Compatible',
      'settings.compatFail': 'Incompatible',
      'settings.arrayHint': 'Comma-separated values',
      'settings.secretHint': 'Stored as provided; the plugin never displays it back.',
      'settings.pending': 'Unsaved changes',
      'settings.changed': 'changed',
      'settings.fieldInvalid': 'Invalid value',
      'settings.group.general': 'General',
      'settings.group.microskills': 'Micro-skills',
      'settings.group.tools': 'Tools',
      'settings.group.loopguard': 'Loop guard',
      'settings.group.subagents': 'Subagents',
      'settings.group.budget': 'Budget',
      'settings.group.storage': 'Storage',
      'settings.group.pricing': 'Pricing',
      'settings.groupOther': 'Other',
      'error.load': 'Could not load data: {message}',
      'error.action': 'Action failed: {message}',
      'error.noSession': 'No session detected. Open a session in a project to see project-scoped data.',
      'error.noSettings': 'Settings are unavailable: {message}',
      'time.never': 'Never',
      'enum.off': 'Off',
      'enum.shadow': 'Shadow',
      'enum.active': 'Active',
      'enum.observe': 'Observe',
      'enum.propose': 'Propose',
      'enum.automatic': 'Automatic',
      'enum.disabled': 'Disabled',
      'enum.conservative': 'Conservative',
      'enum.default': 'Default',
      'enum.aggressive': 'Aggressive',
      'enum.envfacts': 'envfacts (local)',
      'enum.distiller': 'distiller (model)',
      'enum.envfacts+distiller': 'envfacts + distiller',
      'field.mode': 'Mode',
      'field.microskillsEnabled': 'Micro-skills enabled',
      'field.microskillsInject': 'Inject facts into the agent context',
      'field.microskillsProfile': 'Extraction profile',
      'field.microskillsMaxFacts': 'Max active facts',
      'field.microskillsMaxTokens': 'Knowledge block token budget',
      'field.microskillsMinConfirmations': 'Confirmations before activation',
      'field.microskillsRetireDays': 'Retire a fact after (days)',
      'field.toolpruneEnabled': 'Tool pruning enabled',
      'field.toolpruneMode': 'Tool pruning mode',
      'field.toolpruneEvidence': 'Prompts without use before a candidate',
      'field.toolpruneMinSessions': 'Minimum sessions for prompt evidence',
      'field.toolpruneSessions': 'Session shortcut without prompt evidence',
      'field.toolpruneQuietMinutes': 'Quiet minutes before a hide applies',
      'field.toolpruneReauditEvery': 'Re-audit the catalog every N tasks',
      'field.toolpruneAllowlist': 'Tool allowlist',
      'field.loopguardEnabled': 'Loop guard enabled',
      'field.loopguardIntervene': 'Inject a redirect message',
      'field.loopguardLevel': 'Threshold level',
      'field.loopguardJudge': 'Allow the judge model call',
      'field.loopguardConfidence': 'Minimum judge confidence',
      'field.loopguardMaxInterventions': 'Max redirects per turn',
      'field.loopguardJudgeTimeoutMs': 'Judge timeout (ms)',
      'field.loopguardNudgeMaxTokens': 'Max redirect message tokens',
      'field.subagentsEnabled': 'Attribute subagent sessions',
      'field.judgeProvider': 'Judge provider',
      'field.judgeModel': 'Judge model',
      'field.maxOverheadTokensPerTurn': 'Overhead token budget per turn',
      'field.maxOverheadTokensPerSession': 'Overhead token budget per session',
      'field.storeEvidence': 'Store redacted evidence snippets',
      'field.retentionDays': 'Metrics retention (days)',
      'field.maxMetricsBytes': 'Metrics rotation size (bytes)',
      'field.priceTable': 'Price table overrides (JSON)',
      'field.debug': 'Verbose diagnostics',
      'fieldHint.mode': 'Off measures nothing; Shadow measures only; Active applies enabled mechanisms.',
      'fieldHint.microskillsEnabled': 'Learn reusable project facts from successful turns.',
      'fieldHint.microskillsInject': 'Add approved facts to the system prompt in Active mode.',
      'fieldHint.microskillsProfile': 'envfacts uses local signals; distiller uses a model; combined runs both.',
      'fieldHint.microskillsMaxFacts': 'Upper bound on confirmed facts kept active.',
      'fieldHint.microskillsMaxTokens': 'Maximum size of the injected knowledge block.',
      'fieldHint.microskillsMinConfirmations': 'Successful observations required before a fact becomes active.',
      'fieldHint.microskillsRetireDays': 'Facts unused for this long are retired; 0 disables retirement.',
      'fieldHint.toolpruneEnabled': 'Measure tool schemas and hide unused tools in Active mode.',
      'fieldHint.toolpruneMode': 'Observe measures; propose suggests; automatic hides eligible tools.',
      'fieldHint.toolpruneEvidence': 'Completed turns in which the tool was available but never called before it becomes a candidate.',
      'fieldHint.toolpruneMinSessions': 'Distinct sessions the prompt evidence must be spread over.',
      'fieldHint.toolpruneSessions': 'Hide after this many unused sessions even when the prompt count is lower.',
      'fieldHint.toolpruneQuietMinutes': 'Minutes of project inactivity before new automatic hides apply at the next session (0 = immediately).',
      'fieldHint.toolpruneReauditEvery': 'Task interval between catalog audits.',
      'fieldHint.toolpruneAllowlist': 'Comma-separated tool names or glob patterns (mcp__*, **) that must never be hidden.',
      'fieldHint.loopguardEnabled': 'Detect repeated failing calls and stalled edits.',
      'fieldHint.loopguardIntervene': 'Send one redirect when a loop is confirmed; never stops the agent.',
      'fieldHint.loopguardLevel': 'Conservative needs more evidence; aggressive reacts sooner.',
      'fieldHint.loopguardJudge': 'Allow one small model call to confirm a suspected loop.',
      'fieldHint.loopguardConfidence': 'Judge confidence required before redirecting.',
      'fieldHint.loopguardMaxInterventions': 'Redirects allowed per turn.',
      'fieldHint.loopguardJudgeTimeoutMs': 'Abort the judge call after this timeout.',
      'fieldHint.loopguardNudgeMaxTokens': 'Cap the redirect message length.',
      'fieldHint.subagentsEnabled': 'Attribute subagent usage to the parent project and session.',
      'fieldHint.judgeProvider': 'Optional provider override for judge calls; empty uses the session route.',
      'fieldHint.judgeModel': 'Optional model override for judge calls; empty uses the session route.',
      'fieldHint.maxOverheadTokensPerTurn': 'Judge and writer tokens allowed per turn.',
      'fieldHint.maxOverheadTokensPerSession': 'Judge and writer tokens allowed per session.',
      'fieldHint.storeEvidence': 'Keep short redacted snippets behind tool decisions.',
      'fieldHint.retentionDays': 'Delete metric rows older than this.',
      'fieldHint.maxMetricsBytes': 'Rotate the metrics file at this size.',
      'fieldHint.priceTable': 'JSON keyed by provider/model; rates are USD per million tokens.',
      'fieldHint.debug': 'Write extra diagnostics to the plugin error log.',
    }

    const ru = {
      'nav': 'Экономия токенов',
      'title': 'Экономия токенов',
      'subtitle': 'Локальный учёт стоимости, микро-навыки, отсечение инструментов и защита от зацикливания для этого проекта.',
      'tabs.overview': 'Обзор',
      'tabs.skills': 'Микро-навыки',
      'tabs.tools': 'Инструменты',
      'tabs.loops': 'Защита от циклов',
      'tabs.settings': 'Настройки',
      'common.refresh': 'Обновить',
      'common.loading': 'Загрузка…',
      'common.saving': 'Сохранение…',
      'common.reload': 'Перезагрузить',
      'common.dismiss': 'Скрыть',
      'common.none': 'Нет',
      'common.na': 'н/д',
      'common.unknown': 'Неизвестно',
      'common.estimate': 'оценка',
      'common.enabled': 'Включено',
      'common.disabled': 'Выключено',
      'common.advanced': 'дополнительно',
      'common.project': 'Проект',
      'common.root': 'Корень',
      'common.session': 'Сессия',
      'common.version': 'Версия',
      'common.actions': 'Действия',
      'common.done': 'Готово.',
      'mode.off': 'Выкл',
      'mode.shadow': 'Тень',
      'mode.active': 'Активно',
      'mode.offHint': '«Выкл» отключает все механизмы и все измерения.',
      'mode.shadowHint': '«Тень» только наблюдает и измеряет. Ничего не применяется к контексту модели, инструментам и промптам.',
      'mode.activeHint': '«Активно» применяет одобренные оптимизации: внедрение фактов, скрытие инструментов и перенаправления.',
      'mode.current': 'Текущий режим',
      'overview.root': 'Корень проекта',
      'overview.rootUnknown': 'Проект не определён. Откройте сессию в проекте, чтобы привязать его.',
      'overview.modelRequests': 'Запросы к модели',
      'overview.inputTokens': 'Входные токены',
      'overview.outputTokens': 'Выходные токены',
      'overview.effectiveTokens': 'Эффективные токены',
      'overview.effectiveEstimate': 'оценка с учётом кэша',
      'overview.cost': 'Оценка стоимости',
      'overview.costUnavailable': 'стоимость недоступна',
      'overview.costMissing': 'Нет цены для моделей: {models}',
      'overview.savingsTokens': 'Оценка экономии',
      'overview.savingsNote': 'Оценка, а не измеренный факт.',
      'overview.hiddenTools': 'Скрытые инструменты',
      'overview.facts': 'Подтверждённые факты',
      'overview.pendingFacts': 'Факты в ожидании',
      'overview.loopIncidents': 'Инциденты циклов',
      'overview.loopRedirects': 'Перенаправления',
      'overview.recent': 'Последние ходы',
      'overview.recentEmpty': 'Ходы пока не записаны.',
      'overview.measured': 'Что измеряется',
      'overview.measurementNotes': 'Примечания об измерениях',
      'overview.pluginNotes': 'Примечания плагина',
      'overview.rawNote': 'Сырые счётчики входных и выходных токенов сообщает провайдер. Плагин их не считает.',
      'overview.effectiveNote': 'Эффективные токены — оценка с учётом кэша, вычисленная из сообщённых чисел, а не отдельное измерение.',
      'overview.savingsNote2': 'Экономия — это оценка. Она никогда не является измеренным фактом и не должна читаться как гарантия счёта.',
      'overview.sessions': 'Сессии',
      'overview.sessionsValue': 'наблюдалось {observed} · субагенты {subagents} · корни {roots} · ненаблюдаемые {unobserved}',
      'overview.budget': 'Бюджет токенов',
      'overview.budgetSession': 'Накладные расходы сессии: {used} из {limit} токенов',
      'overview.budgetTurn': 'Этот ход: {tokens} токенов',
      'overview.overhead': 'Накладные токены проекта',
      'overview.storage': 'Хранилище',
      'overview.storageBytes': '{bytes} байт',
      'overview.storageRoot': 'Корень хранилища',
      'overview.projects': 'Проекты',
      'overview.projectsTracked': 'В учёте: {n}',
      'overview.turnLabel': 'Этот ход',
      'overview.storageSize': 'Размер метрик',
      'overview.storageSchema': 'Версия схемы',
      'overview.lastIncident': 'Последний инцидент: {when}',
      'overview.tableTime': 'Время',
      'overview.tableRequests': 'Запросы',
      'overview.tableInput': 'Вход',
      'overview.tableOutput': 'Выход',
      'overview.tableEffective': 'Эффективные',
      'overview.tableCost': 'Стоимость',
      'overview.tableToolCalls': 'Вызовы',
      'overview.tableToolErrors': 'Ошибки',
      'overview.tableTokens': 'Вход / выход',
      'overview.tableCalls': 'Вызовы',
      'overview.tableErrors': 'Ошибки',
      'tools.protectedSummary': 'Показать защищённые имена ({n})',
      'tools.callsTitle': '{calls} вызовов в {sessions} сессиях',
      'tools.saved': 'Сэкономлено токенов на запрос',
      'settings.groupFields': 'Полей: {n}',
      'settings.groupChanged': 'изменено: {n}',
      'settings.groupInvalid': 'ошибок: {n}',
      'settings.expandAll': 'Развернуть все',
      'settings.collapseAll': 'Свернуть все',
      'settings.clean': 'Все изменения сохранены.',
      'skills.injected': 'Внедрённые факты',
      'skills.pending': 'Кандидаты в ожидании',
      'skills.budget': 'Бюджет токенов',
      'skills.budgetValue': '{used} из {max} токенов',
      'skills.injection': 'Внедрение в контекст',
      'skills.injectionOff': 'Факты сохраняются, но не отправляются модели: внедрение выключено или плагин не в активном режиме.',
      'skills.untrusted': 'Выученный текст — незаверенные доказательства. Считайте его данными, а не инструкциями.',
      'skills.confirmed': 'Подтверждённые факты',
      'skills.confirmedEmpty': 'Подтверждённых фактов для этого проекта пока нет.',
      'skills.candidates': 'Кандидаты в ожидании',
      'skills.candidatesEmpty': 'Кандидатов в ожидании нет.',
      'skills.retired': 'Выведенные факты',
      'skills.retiredEmpty': 'Выведенных фактов нет.',
      'skills.confirm': 'Подтвердить',
      'skills.reject': 'Отклонить',
      'skills.delete': 'Удалить',
      'skills.deleteConfirm': 'Удалить этот выученный факт? Из интерфейса его нельзя восстановить.',
      'skills.confirmations': 'Подтверждений: {n}',
      'skills.sessions': 'Сессий: {n}',
      'skills.lastSeen': 'Последний раз: {when}',
      'skills.sensitive': 'чувствительный',
      'skills.source': 'Источник',
      'skills.maxFacts': 'Максимум фактов: {n}',
      'skills.retireDays': 'Выводить через {n} дн.',
      'fact.status.candidate': 'кандидат',
      'fact.status.confirmed': 'подтверждён',
      'fact.status.retired': 'выведен',
      'tools.mode': 'Режим отсечения',
      'tools.mode.observe': 'Наблюдение',
      'tools.mode.propose': 'Предложение',
      'tools.mode.automatic': 'Автоматически',
      'tools.modeHint.observe': 'Наблюдение записывает использование и никогда не скрывает инструмент.',
      'tools.modeHint.propose': 'Предложение формирует список кандидатов и ждёт вашего решения.',
      'tools.modeHint.automatic': 'Автоматически скрывает инструменты, прошедшие порог доказательств. Работает только в активном режиме.',
      'tools.hidden': 'Скрытые инструменты',
      'tools.hiddenEmpty': 'Скрытых инструментов нет.',
      'tools.restore': 'Вернуть',
      'tools.restoreAll': 'Вернуть все',
      'tools.protected': 'Защищённые имена',
      'tools.protectedEmpty': 'Защищённых имён нет.',
      'tools.entries': 'Использование инструментов',
      'tools.entriesEmpty': 'Использование инструментов для этого проекта пока не записано.',
      'tools.lastAudit': 'Последняя проверка: {when}',
      'tools.colName': 'Инструмент',
      'tools.colCalls': 'Вызовы',
      'tools.colSessions': 'Сессии',
      'tools.colErrors': 'Ошибки',
      'tools.colTokens': 'Токены',
      'tools.colStatus': 'Статус',
      'tools.colReason': 'Причина',
      'tools.colLastUsed': 'Последний раз',
      'tools.evidenceValue': '{prompts}/{promptsRequired} ходов в {sessions}/{sessionsRequired} сессиях',
      'tools.status.active': 'активен',
      'tools.status.hidden': 'скрыт',
      'tools.status.protected': 'защищён',
      'tools.status.allowlisted': 'в белом списке',
      'tools.disabledHint': 'Отсечение инструментов выключено в настройках.',
      'loops.incidents': 'Инциденты',
      'loops.redirected': 'Перенаправлено',
      'loops.recovered': 'Восстановлено',
      'loops.judgeCalls': 'Вызовы судьи',
      'loops.judgeTokensLabel': 'Токены судьи',
      'loops.budgetExhausted': 'Бюджет исчерпан',
      'loops.config': 'Настройки защиты',
      'loops.configEnabled': 'Включено',
      'loops.configIntervene': 'Вмешательство',
      'loops.configConfidence': 'Порог уверенности',
      'loops.configMax': 'Максимум вмешательств за ход',
      'loops.configLevel': 'Уровень',
      'loops.list': 'Инциденты (сначала новые)',
      'loops.empty': 'Инцидентов циклов для этого проекта нет.',
      'loops.clear': 'Очистить историю',
      'loops.clearConfirm': 'Очистить историю инцидентов защиты от циклов для этого проекта? Сводные счётчики сохранятся.',
      'loops.redirect': 'Сообщение перенаправления',
      'loops.signals': 'Сигналы',
      'loops.signalsValue': 'ходов {turns} · ошибок {errors} · изменчивость {churn} · файлов {files} · застой {stagnation}',
      'loops.turn': 'Ход {n}',
      'loops.level': 'Уровень {n}',
      'loops.judge': 'Судья',
      'loops.judgeNotUsed': 'Судья не использовался',
      'loops.judgeConfidence': 'уверенность {value}',
      'loops.judgeModel': 'модель {model}',
      'loops.judgeTokens': 'токенов: {n}',
      'loops.judgeError': 'Ошибка судьи: {message}',
      'loops.decision': 'Решение',
      'loops.outcome': 'Итог',
      'loops.reason': 'Причина',
      'loops.decision.none': 'нет',
      'loops.decision.redirected': 'перенаправлено',
      'loops.decision.skipped': 'пропущено',
      'loops.decision.budget-exhausted': 'бюджет исчерпан',
      'loops.outcome.recovered': 'восстановлено',
      'loops.outcome.continued': 'продолжено',
      'loops.outcome.unknown': 'неизвестно',
      'loops.judgeOutcome.stuck': 'застрял',
      'loops.judgeOutcome.progress': 'прогресс',
      'loops.judgeOutcome.unavailable': 'недоступен',
      'loops.judgeOutcome.skipped': 'пропущен',
      'loops.judgeOutcome.disabled': 'выключен',
      'settings.title': 'Настройки',
      'settings.save': 'Сохранить изменения',
      'settings.saved': 'Настройки сохранены.',
      'settings.invalid': 'Некоторые значения некорректны. Исправьте их перед сохранением.',
      'settings.readOnly': 'Настройки только для чтения: {reason}',
      'settings.compat': 'Совместимость',
      'settings.compatReason': 'Причина: {reason}',
      'settings.testedRange': 'Проверенный диапазон DSH: {range}',
      'settings.revision': 'Ревизия {value}',
      'settings.notes': 'Примечания',
      'settings.pluginVersion': 'Версия плагина',
      'settings.dshVersion': 'Версия DSH',
      'settings.compatOk': 'Совместимо',
      'settings.compatFail': 'Несовместимо',
      'settings.arrayHint': 'Значения через запятую',
      'settings.secretHint': 'Хранится как передано; плагин его не показывает.',
      'settings.pending': 'Несохранённые изменения',
      'settings.changed': 'изменено',
      'settings.fieldInvalid': 'Некорректное значение',
      'settings.group.general': 'Общие',
      'settings.group.microskills': 'Микро-навыки',
      'settings.group.tools': 'Инструменты',
      'settings.group.loopguard': 'Защита от циклов',
      'settings.group.subagents': 'Субагенты',
      'settings.group.budget': 'Бюджет',
      'settings.group.storage': 'Хранилище',
      'settings.group.pricing': 'Цены',
      'settings.groupOther': 'Прочее',
      'error.load': 'Не удалось загрузить данные: {message}',
      'error.action': 'Действие не выполнено: {message}',
      'error.noSession': 'Сессия не обнаружена. Откройте сессию в проекте, чтобы видеть данные проекта.',
      'error.noSettings': 'Настройки недоступны: {message}',
      'time.never': 'Никогда',
      'enum.off': 'Выкл',
      'enum.shadow': 'Тень',
      'enum.active': 'Активно',
      'enum.observe': 'Наблюдение',
      'enum.propose': 'Предложение',
      'enum.automatic': 'Автоматически',
      'enum.disabled': 'Отключено',
      'enum.conservative': 'Консервативный',
      'enum.default': 'По умолчанию',
      'enum.aggressive': 'Агрессивный',
      'enum.envfacts': 'envfacts (локально)',
      'enum.distiller': 'distiller (модель)',
      'enum.envfacts+distiller': 'envfacts + distiller',
      'field.mode': 'Режим',
      'field.microskillsEnabled': 'Микро-навыки включены',
      'field.microskillsInject': 'Внедрять факты в контекст агента',
      'field.microskillsProfile': 'Профиль извлечения',
      'field.microskillsMaxFacts': 'Максимум активных фактов',
      'field.microskillsMaxTokens': 'Бюджет токенов блока знаний',
      'field.microskillsMinConfirmations': 'Подтверждений до активации',
      'field.microskillsRetireDays': 'Выводить факт через (дней)',
      'field.toolpruneEnabled': 'Отсечение инструментов включено',
      'field.toolpruneMode': 'Режим отсечения инструментов',
      'field.toolpruneEvidence': 'Ходов без использования до кандидата',
      'field.toolpruneMinSessions': 'Минимум сессий для evidence по ходам',
      'field.toolpruneSessions': 'Порог по сессиям без учёта ходов',
      'field.toolpruneQuietMinutes': 'Минут тишины до применения скрытия',
      'field.toolpruneReauditEvery': 'Перепроверка каталога каждые N задач',
      'field.toolpruneAllowlist': 'Белый список инструментов',
      'field.loopguardEnabled': 'Защита от циклов включена',
      'field.loopguardIntervene': 'Внедрять перенаправление',
      'field.loopguardLevel': 'Уровень порогов',
      'field.loopguardJudge': 'Разрешить вызов судьи',
      'field.loopguardConfidence': 'Минимальная уверенность судьи',
      'field.loopguardMaxInterventions': 'Максимум перенаправлений за ход',
      'field.loopguardJudgeTimeoutMs': 'Таймаут судьи (мс)',
      'field.loopguardNudgeMaxTokens': 'Максимум токенов перенаправления',
      'field.subagentsEnabled': 'Учитывать субагентов',
      'field.judgeProvider': 'Провайдер судьи',
      'field.judgeModel': 'Модель судьи',
      'field.maxOverheadTokensPerTurn': 'Бюджет накладных токенов за ход',
      'field.maxOverheadTokensPerSession': 'Бюджет накладных токенов за сессию',
      'field.storeEvidence': 'Хранить очищенные фрагменты доказательств',
      'field.retentionDays': 'Хранение метрик (дней)',
      'field.maxMetricsBytes': 'Ротация файла метрик (байты)',
      'field.priceTable': 'Таблица цен (JSON)',
      'field.debug': 'Подробная диагностика',
      'fieldHint.mode': 'Off ничего не измеряет; Shadow только измеряет; Active применяет включённые механизмы.',
      'fieldHint.microskillsEnabled': 'Изучать переиспользуемые факты проекта по успешным ходам.',
      'fieldHint.microskillsInject': 'Добавлять подтверждённые факты в системный промпт в режиме Active.',
      'fieldHint.microskillsProfile': 'envfacts использует локальные сигналы; distiller — модель; combined запускает оба.',
      'fieldHint.microskillsMaxFacts': 'Верхняя граница активных подтверждённых фактов.',
      'fieldHint.microskillsMaxTokens': 'Максимальный размер внедряемого блока знаний.',
      'fieldHint.microskillsMinConfirmations': 'Сколько успешных наблюдений нужно до активации факта.',
      'fieldHint.microskillsRetireDays': 'Факты, не использованные столько дней, выводятся; 0 отключает вывод.',
      'fieldHint.toolpruneEnabled': 'Измерять схемы инструментов и скрывать неиспользуемые в Active.',
      'fieldHint.toolpruneMode': 'Observe измеряет; propose предлагает; automatic скрывает подходящие инструменты.',
      'fieldHint.toolpruneEvidence': 'Завершённых ходов, в которых инструмент был доступен, но не вызывался, прежде чем он станет кандидатом.',
      'fieldHint.toolpruneMinSessions': 'По скольким разным сессиям должны быть распределены эти ходы.',
      'fieldHint.toolpruneSessions': 'Скрыть после стольких неиспользованных сессий, даже если ходов меньше.',
      'fieldHint.toolpruneQuietMinutes': 'Сколько минут проект должен быть неактивен, чтобы новое скрытие применилось в следующей сессии (0 — сразу).',
      'fieldHint.toolpruneReauditEvery': 'Интервал задач между проверками каталога.',
      'fieldHint.toolpruneAllowlist': 'Имена или glob-шаблоны через запятую (mcp__*, **), которые нельзя скрывать.',
      'fieldHint.loopguardEnabled': 'Искать повторяющиеся ошибки вызовов и застой в правках.',
      'fieldHint.loopguardIntervene': 'Отправить одно перенаправление при подтверждённом цикле; агент не останавливается.',
      'fieldHint.loopguardLevel': 'Conservative требует больше доказательств; aggressive реагирует раньше.',
      'fieldHint.loopguardJudge': 'Разрешить один короткий вызов модели для подтверждения цикла.',
      'fieldHint.loopguardConfidence': 'Минимальная уверенность судьи для перенаправления.',
      'fieldHint.loopguardMaxInterventions': 'Сколько перенаправлений разрешено за ход.',
      'fieldHint.loopguardJudgeTimeoutMs': 'Прервать вызов судьи по таймауту.',
      'fieldHint.loopguardNudgeMaxTokens': 'Ограничить длину сообщения-перенаправления.',
      'fieldHint.subagentsEnabled': 'Относить расход субагентов к родительскому проекту и сессии.',
      'fieldHint.judgeProvider': 'Необязательный провайдер судьи; пусто — маршрут сессии.',
      'fieldHint.judgeModel': 'Необязательная модель судьи; пусто — модель сессии.',
      'fieldHint.maxOverheadTokensPerTurn': 'Токены судьи и писателя на ход.',
      'fieldHint.maxOverheadTokensPerSession': 'Токены судьи и писателя на сессию.',
      'fieldHint.storeEvidence': 'Хранить короткие очищенные фрагменты обоснований.',
      'fieldHint.retentionDays': 'Удалять строки метрик старше этого срока.',
      'fieldHint.maxMetricsBytes': 'Ротировать файл метрик при этом размере.',
      'fieldHint.priceTable': 'JSON по ключу provider/model; ставки — USD за миллион токенов.',
      'fieldHint.debug': 'Писать подробную диагностику в журнал ошибок плагина.',
    }

    const css = `
.te-root{--te-radius:12px;--te-gap:14px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;width:100%;max-width:1160px;margin:0 auto;padding:12px 16px 40px 20px;box-sizing:border-box;container-type:inline-size;min-width:0;overflow-x:clip}
.te-root *{box-sizing:border-box}
.te-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin:0 0 14px;flex-wrap:wrap}
.te-title{margin:0 0 3px;font-size:18px;font-weight:650;letter-spacing:-.01em}
.te-sub{margin:0;color:var(--dsw-alias-label-secondary);font-size:12.5px;max-width:720px}
.te-head-actions{display:flex;gap:8px;flex-wrap:wrap}
.te-tabs{display:flex;gap:2px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-l1);margin:0 0 16px}
.te-tab{appearance:none;background:transparent;border:0;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-weight:550;padding:9px 12px;white-space:nowrap}
.te-tab:hover{color:var(--dsw-alias-label-primary)}
.te-tab[aria-selected="true"]{border-bottom-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.te-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 11px;font:inherit;font-size:12px;font-weight:550;cursor:pointer;display:inline-flex;align-items:center;gap:6px;min-height:30px}
.te-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.te-btn:disabled{opacity:.45;cursor:default}
.te-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}
.te-btn-primary:hover{background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-label-primary-foreground)}
.te-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.te-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.te-btn-ghost:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.te-grid{display:grid;gap:var(--te-gap)}
.te-grid-4{grid-template-columns:repeat(4,minmax(0,1fr))}
.te-grid-3{grid-template-columns:repeat(3,minmax(0,1fr))}
.te-grid-2{grid-template-columns:repeat(2,minmax(0,1fr))}
.te-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:var(--te-radius);padding:14px;min-width:0}
.te-card-title{font-weight:650;font-size:12px;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em;margin:0 0 10px}
.te-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 10px;flex-wrap:wrap}
.te-section-head h3{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em}
.te-stat-top{display:flex;align-items:flex-start;justify-content:space-between;gap:6px}
.te-stat-value{font-size:24px;font-weight:650;letter-spacing:-.02em;line-height:1.15;overflow-wrap:anywhere}
.te-stat-label{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:3px}
.te-stat-hint{color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:5px;overflow-wrap:anywhere}
.te-kv{display:grid;grid-template-columns:150px minmax(0,1fr);gap:7px 12px;align-items:start;margin:0}
.te-kv dt{color:var(--dsw-alias-label-secondary);font-size:12px}
.te-kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.te-code{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11.5px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:2px 5px;overflow-wrap:anywhere}
.te-badge{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:1px 7px;font-size:10.5px;font-weight:600;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.te-badge-ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}
.te-badge-warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent)}
.te-badge-bad{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
.te-badge-brand{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}
.te-muted{color:var(--dsw-alias-label-secondary)}
.te-small{font-size:11.5px}
.te-mono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)}
.te-stack{display:grid;gap:var(--te-gap)}
.te-inline{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.te-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.te-right{margin-left:auto}
.te-empty{border:1px dashed var(--dsw-alias-border-l1);border-radius:10px;padding:20px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}
.te-alert{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:9px 11px;font-size:12px;margin:0 0 12px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.te-alert-error{border-left-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 6%,var(--dsw-alias-bg-layer-1))}
.te-alert-warn{border-left-color:var(--dsw-alias-state-warn-primary)}
.te-alert-ok{border-left-color:var(--dsw-alias-state-success-primary)}
.te-form{display:grid;gap:10px}
.te-field{display:grid;gap:4px;min-width:0}
.te-field-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.te-field label{font-size:11.5px;color:var(--dsw-alias-label-secondary);font-weight:550}
.te-field-error{font-size:11px;color:var(--dsw-alias-state-error-primary)}
.te-input,.te-select{width:100%;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;padding:7px 9px;min-height:32px}
.te-input:focus,.te-select:focus{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);outline-offset:0;border-color:var(--dsw-alias-brand-primary)}
.te-toggle{display:flex;align-items:flex-start;gap:9px;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}
.te-toggle input{margin:3px 0 0;accent-color:var(--dsw-alias-brand-primary);flex:none}
.te-toggle-text{min-width:0;display:flex;flex-direction:column;gap:2px}
.te-toggle-title{font-weight:550;font-size:12.5px}
.te-toggle-hint{color:var(--dsw-alias-label-secondary);font-size:11.5px;margin-top:2px}
.te-table-wrap{width:100%;min-width:0;overflow:clip}
.te-table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:12px}
.te-table th{text-align:left;font-weight:650;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);padding:8px;white-space:nowrap;overflow-wrap:normal;word-break:normal;hyphens:none;vertical-align:middle;font-size:10.5px;line-height:1.25;text-transform:uppercase;letter-spacing:.04em}
.te-table td{border-bottom:1px solid var(--dsw-alias-border-l1);padding:8px;vertical-align:middle;white-space:normal;overflow-wrap:anywhere;word-break:normal;line-height:1.4}
.te-table tbody tr:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent)}
.te-table tr:last-child td{border-bottom:0}
.te-table .te-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.te-table .te-nowrap{white-space:nowrap}
.te-table .te-error-text{color:var(--dsw-alias-state-error-primary);font-weight:600}
.te-table .te-subline{display:block;color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:1.35;margin-top:2px;overflow-wrap:anywhere}
.te-table .te-tool-cell{display:grid;gap:3px;min-width:0}
.te-table .te-tool-cell .te-code{justify-self:start;max-width:100%}
.te-table-tools td{vertical-align:top}
.te-table-tools td:first-child{padding-top:7px}
.te-table .te-tool-reason{font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.te-table .te-tool-evidence{font-size:10.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.te-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.te-table-overview th:nth-child(1){width:22%}
.te-table-overview th:nth-child(2){width:20%}
.te-table-overview th:nth-child(3){width:14%}
.te-table-overview th:nth-child(4){width:14%}
.te-table-overview th:nth-child(5){width:15%}
.te-table-overview th:nth-child(6){width:15%}
.te-table-tools th:nth-child(1){width:31%}
.te-table-tools th:nth-child(2){width:13%}
.te-table-tools th:nth-child(3){width:12%}
.te-table-tools th:nth-child(4){width:9%}
.te-table-tools th:nth-child(5){width:11%}
.te-table-tools th:nth-child(6){width:24%}
.te-savebar{position:sticky;bottom:0;z-index:3;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 92%,transparent);backdrop-filter:blur(6px);border-radius:10px;padding:10px 12px;margin-top:4px}
.te-savebar .te-alert{margin:0}
.te-savebar-info{min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.te-settings-group{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:var(--te-radius);overflow:hidden}
.te-settings-group>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 14px;cursor:pointer;list-style:none;user-select:none}
.te-settings-group>summary::-webkit-details-marker{display:none}
.te-settings-group>summary::after{content:'⌄';color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;transition:transform .15s ease;flex:none}
.te-settings-group[open]>summary::after{transform:rotate(180deg)}
.te-settings-group[open]>summary{border-bottom:1px solid var(--dsw-alias-border-l1)}
.te-settings-group>.te-form{padding:14px}
.te-group-title{font-weight:650;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);min-width:0}
.te-group-meta{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:normal;text-align:right;line-height:1.35;margin-left:auto;max-width:60%}
.te-group-controls{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.te-field-help{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.4;margin:0 0 2px;max-width:72ch}
.te-protected>summary{font-weight:550}
.te-protected .te-chips{padding:0 2px 2px}
.te-modes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.te-mode-btn{appearance:none;text-align:left;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:inherit;border-radius:9px;padding:9px 10px;font:inherit;cursor:pointer;display:grid;gap:3px;min-width:0}
.te-mode-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.te-mode-btn.is-selected{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-layer-1))}
.te-mode-btn:disabled{opacity:.5;cursor:default}
.te-mode-name{font-weight:600;font-size:12.5px}
.te-mode-hint{color:var(--dsw-alias-label-secondary);font-size:11px}
.te-mode-legend{display:grid;gap:5px;margin-top:10px;font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.te-fact{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:10px;background:var(--dsw-alias-bg-base);display:grid;gap:7px;min-width:0}
.te-fact-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;flex-wrap:wrap}
.te-fact-text{font-size:12.5px;overflow-wrap:anywhere;min-width:0;flex:1 1 220px;white-space:pre-wrap}
.te-fact-meta{display:flex;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:11px}
.te-chip{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:0 5px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.te-hidden-item{display:flex;align-items:center;gap:8px;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.te-hidden-item:last-child{border-bottom:0}
.te-details{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px;background:var(--dsw-alias-bg-layer-1);margin-top:7px}
.te-details summary{cursor:pointer;font-size:11.5px;color:var(--dsw-alias-label-secondary);font-weight:550}
.te-details-body{margin-top:7px;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)}
.te-incident{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:10px;display:grid;gap:6px;min-width:0}
.te-incident-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11.5px}
.te-incident-reason{font-size:12px;overflow-wrap:anywhere}
.te-loading{display:grid;place-items:center;min-height:160px;color:var(--dsw-alias-label-secondary);font-size:12px}
.te-spinner{width:18px;height:18px;border-radius:50%;border:2px solid var(--dsw-alias-border-l1);border-top-color:var(--dsw-alias-brand-primary);animation:te-spin .8s linear infinite;margin-bottom:8px}
@keyframes te-spin{to{transform:rotate(360deg)}}
@container (max-width:700px){.te-grid-4{grid-template-columns:repeat(2,minmax(0,1fr))}.te-grid-3{grid-template-columns:repeat(2,minmax(0,1fr))}.te-modes{grid-template-columns:1fr}.te-kv{grid-template-columns:110px minmax(0,1fr)}}
@container (max-width:560px){.te-grid-4,.te-grid-3,.te-grid-2{grid-template-columns:1fr}.te-kv{grid-template-columns:1fr;gap:2px}.te-kv dt{margin-top:7px}.te-kv dt:first-child{margin-top:0}.te-table-overview th:nth-child(3),.te-table-overview td:nth-child(3),.te-table-overview th:nth-child(6),.te-table-overview td:nth-child(6){display:none}.te-table-tools th:nth-child(5),.te-table-tools td:nth-child(5){display:none}}
@media (max-width:700px){.te-grid-4,.te-grid-3{grid-template-columns:repeat(2,minmax(0,1fr))}.te-modes{grid-template-columns:1fr}}
@media (max-width:480px){.te-grid-4,.te-grid-3,.te-grid-2{grid-template-columns:1fr}.te-title{font-size:16px}.te-root{padding-bottom:18px}}
@media (prefers-reduced-motion:reduce){.te-spinner{animation:none}}
`

    const STYLE_SELECTOR = 'style[data-dsh-token-economizer="settings"]'

    function mountStyle() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.querySelector(STYLE_SELECTOR)
      if (existing) {
        existing.textContent = css
        return () => {}
      }
      const style = document.createElement('style')
      style.dataset.dshTokenEconomizer = 'settings'
      style.textContent = css
      document.head.appendChild(style)
      return () => {
        if (style.parentNode) style.parentNode.removeChild(style)
      }
    }

    function bindT(ctx) {
      const translate = ctx.locale.bind(NS)
      return (key, params) => {
        const value = translate(key, params)
        return typeof value === 'string' ? value : String(value === undefined ? key : value)
      }
    }

    async function apiGet(path, query) {
      const url = new URL(API + path, window.location.origin)
      if (query) {
        for (const [key, value] of Object.entries(query)) {
          if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
        }
      }
      const response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      return readResponse(response)
    }

    async function apiPost(path, payload) {
      const response = await fetch(API + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload || {}),
      })
      return readResponse(response)
    }

    async function readResponse(response) {
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error('HTTP ' + response.status)
      }
      if (!response.ok || !body || body.ok === false) {
        const error = new Error((body && body.error && body.error.message) || 'HTTP ' + response.status)
        error.code = body && body.error ? body.error.code : undefined
        throw error
      }
      return body
    }

    const LOCALE_TAGS = {
      ru: 'ru-RU', en: 'en-US', zh: 'zh-CN', ja: 'ja-JP', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', pt: 'pt-PT',
    }

    function localeTag(locale) {
      return LOCALE_TAGS[locale] || 'en-US'
    }

    function formatInt(value, locale) {
      const number = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(number)) return null
      try {
        return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 0 }).format(number)
      } catch {
        return String(number)
      }
    }

    function formatUsd(value, locale) {
      const number = Number(value)
      if (!Number.isFinite(number)) return null
      try {
        return new Intl.NumberFormat(localeTag(locale), {
          style: 'currency', currency: 'USD', maximumFractionDigits: 4,
        }).format(number)
      } catch {
        return null
      }
    }

    function formatPercent(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return null
      return Math.round(number * 100) + '%'
    }

    function formatDate(value, locale) {
      if (!value) return null
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      try {
        return new Intl.DateTimeFormat(localeTag(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(date)
      } catch {
        return date.toLocaleString()
      }
    }

    /** One-line timestamp for dense tables; the full value stays in the title. */
    function formatCompactDate(value, locale) {
      if (!value) return null
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      try {
        return new Intl.DateTimeFormat(localeTag(locale), {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        }).format(date)
      } catch {
        return date.toLocaleString()
      }
    }

    function num(value, t, locale) {
      const formatted = formatInt(value, locale)
      return formatted === null ? t('common.na') : formatted
    }

    function humanize(key) {
      const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim()
      if (!words) return String(key)
      return words.charAt(0).toUpperCase() + words.slice(1)
    }

    function labelOrRaw(t, prefix, value, fallback) {
      if (value === null || value === undefined || value === '') return fallback
      const key = prefix + String(value)
      const label = t(key)
      return label === key ? String(value) : label
    }

    function enumLabel(t, value) {
      return labelOrRaw(t, 'enum.', value, t('common.unknown'))
    }

    function fieldLabel(t, key) {
      const dictKey = 'field.' + key
      const label = t(dictKey)
      return label === dictKey ? humanize(key) : label
    }

    function fieldHint(t, key) {
      const dictKey = 'fieldHint.' + key
      const hint = t(dictKey)
      return hint === dictKey ? null : hint
    }

    function groupLabel(t, group) {
      if (!group) return t('settings.groupOther')
      const key = 'settings.group.' + group
      const label = t(key)
      return label === key ? humanize(group) : label
    }

    function modeTone(mode) {
      if (mode === 'active') return 'ok'
      if (mode === 'shadow') return 'warn'
      return ''
    }

    function Badge({ text, tone }) {
      return h('span', { className: 'te-badge' + (tone ? ' te-badge-' + tone : '') }, text)
    }

    function Button({ children, onClick, disabled, variant, title, type }) {
      return h('button', {
        type: type || 'button',
        className: 'te-btn' + (variant ? ' te-btn-' + variant : ''),
        onClick,
        disabled: Boolean(disabled),
        title,
      }, children)
    }

    function Toggle({ checked, onChange, title, hint, disabled }) {
      return h('label', { className: 'te-toggle' },
        h('input', {
          type: 'checkbox',
          checked: Boolean(checked),
          onChange: (event) => onChange(event.target.checked),
          disabled,
        }),
        h('span', { className: 'te-toggle-text' },
          h('span', { className: 'te-toggle-title' }, title),
          hint ? h('span', { className: 'te-toggle-hint' }, hint) : null,
        ),
      )
    }

    function Card({ title, actions, children }) {
      return h('div', { className: 'te-card' },
        title || actions
          ? h('div', { className: 'te-section-head' }, h('h3', null, title || ''), actions || null)
          : null,
        children,
      )
    }

    function Stat({ value, label, hint, badge }) {
      return h('div', { className: 'te-card' },
        h('div', { className: 'te-stat-top' },
          h('div', { className: 'te-stat-value' }, value),
          badge ? h(Badge, { text: badge, tone: 'brand' }) : null,
        ),
        h('div', { className: 'te-stat-label' }, label),
        hint ? h('div', { className: 'te-stat-hint' }, hint) : null,
      )
    }

    function Empty({ children }) {
      return h('div', { className: 'te-empty' }, children)
    }

    function Loading({ t }) {
      return h('div', { className: 'te-loading' }, h('div', { className: 'te-spinner' }), t('common.loading'))
    }

    function Alert({ kind, children }) {
      return h('div', { className: 'te-alert' + (kind ? ' te-alert-' + kind : '') }, children)
    }

    function tableHead(column, index) {
      const spec = typeof column === 'string' ? { label: column } : column
      return h('th', {
        key: index,
        scope: 'col',
        className: spec.className,
        style: spec.width ? { width: spec.width } : undefined,
      }, spec.label)
    }

    function tableCell(cell, index) {
      const spec = cell && typeof cell === 'object' && !Array.isArray(cell)
        && !(typeof React.isValidElement === 'function' && React.isValidElement(cell))
        && Object.prototype.hasOwnProperty.call(cell, 'value')
        ? cell
        : { value: cell }
      return h('td', {
        key: index,
        className: spec.className,
        title: spec.title,
      }, spec.value)
    }

    function Table({ columns, rows, className }) {
      return h('div', { className: 'te-table-wrap' },
        h('table', { className: 'te-table' + (className ? ' ' + className : '') },
          h('thead', null, h('tr', null, columns.map(tableHead))),
          h('tbody', null, rows.map((row, rowIndex) =>
            h('tr', { key: rowIndex }, row.map(tableCell))),
          ),
        ),
      )
    }

    function useLocaleRevision(ctx) {
      const [revision, setRevision] = React.useState(ctx.locale && ctx.locale.getSnapshot ? ctx.locale.getSnapshot().revision : 0)
      React.useEffect(() => {
        if (!ctx.locale || !ctx.locale.subscribe) return undefined
        setRevision(ctx.locale.getSnapshot().revision)
        return ctx.locale.subscribe(() => setRevision(ctx.locale.getSnapshot().revision))
      }, [ctx])
      return revision
    }

    function pickSession(state, preferredId) {
      const byId = (state && state.byId) || {}
      if (preferredId && byId[preferredId]) return byId[preferredId]
      const ids = Array.isArray(state && state.ids) ? state.ids : Object.keys(byId)
      let best = null
      let bestScore = -1
      let bestUpdated = -1
      for (const id of ids) {
        const session = byId[id]
        if (!session) continue
        const cwd = session.cwd || (session.preview && session.preview.cwd)
        const retained = session.retainedBy || {}
        const score = (retained.mainView ? 4 : 0) + (retained.panel ? 2 : 0) + (cwd ? 1 : 0)
        const updated = Number(session.updatedAt) || 0
        if (score > bestScore || (score === bestScore && updated > bestUpdated)) {
          best = session
          bestScore = score
          bestUpdated = updated
        }
      }
      return best
    }

    function SessionRoot(props) {
      const state = props.useSessions((snapshot) => snapshot)
      const preferred = props.sessionId || (props.session && (props.session.id || props.session.sessionId)) || ''
      const session = pickSession(state, preferred)
      const sessionId = (session && session.id) || preferred || ''
      const cwd = (session && (session.cwd || (session.preview && session.preview.cwd))) || props.cwd || ''
      return h(App, Object.assign({}, props, { shellSessionId: sessionId, shellCwd: cwd }))
    }

    function Root(props) {
      if (typeof props.useSessions === 'function') return h(SessionRoot, props)
      const session = props.session || null
      const sessionId = props.sessionId || (session && (session.id || session.sessionId)) || ''
      const cwd = props.cwd || (session && session.cwd) || ''
      return h(App, Object.assign({}, props, { shellSessionId: sessionId, shellCwd: cwd }))
    }

    function ModeLegend({ t }) {
      return h('div', { className: 'te-mode-legend' },
        h('div', null, h('strong', null, t('mode.shadow') + ': '), t('mode.shadowHint')),
        h('div', null, h('strong', null, t('mode.active') + ': '), t('mode.activeHint')),
        h('div', null, h('strong', null, t('mode.off') + ': '), t('mode.offHint')),
      )
    }

    function OverviewTab({ overview, status, projectsInfo, cwd, t, locale, busy, onSetMode }) {
      const st = status || (overview && overview.status) || {}
      const totals = st.totals || {}
      const mechanisms = st.mechanisms || {}
      const micro = mechanisms.microskills || {}
      const prune = mechanisms.toolprune || {}
      const loop = mechanisms.loopguard || {}
      const budget = st.budget || {}
      const storage = st.storage || {}
      const mode = st.mode || 'off'
      const project = st.project || null
      const knownProjects = (projectsInfo && projectsInfo.projects) || []
      const projectRow = project ? null : knownProjects.find((row) => row.root === cwd || row.root === (st.project && st.project.root))
      const root = (project && project.root) || (projectRow && projectRow.root) || ''

      const recent = Array.isArray(overview && overview.recent) ? overview.recent.slice(-20) : []
      const metricRows = recent.map((point) => {
        const fullTime = formatDate(point.at, locale) || t('time.never')
        const shortTime = formatCompactDate(point.at, locale) || fullTime
        const errors = Number(point.toolErrors) || 0
        return [
          { value: h('time', { dateTime: point.at || undefined, title: fullTime }, shortTime), className: 'te-nowrap' },
          {
            value: h('span', null,
              num(point.inputTokens, t, locale),
              h('span', { className: 'te-muted' }, ' / '),
              num(point.outputTokens, t, locale)),
            className: 'te-num',
          },
          {
            value: point.effectiveTokens === null || point.effectiveTokens === undefined
              ? t('common.na')
              : num(point.effectiveTokens, t, locale),
            className: 'te-num',
          },
          { value: formatUsd(point.costUsd, locale) || t('overview.costUnavailable'), className: 'te-num' },
          { value: num(point.toolCalls, t, locale), className: 'te-num' },
          {
            value: num(point.toolErrors, t, locale),
            className: 'te-num' + (errors > 0 ? ' te-error-text' : ' te-muted'),
          },
        ]
      })

      const sessions = (overview && overview.sessions) || {}
      const loopsOverview = (overview && overview.loops) || {}
      const costMissing = Array.isArray(totals.costUnavailableModels) ? totals.costUnavailableModels : []
      const savingsUsd = formatUsd(totals.estimatedSavingsUsd, locale)
      const savingsValue = num(totals.estimatedSavingsTokens, t, locale) + (savingsUsd ? ' · ' + savingsUsd : '')
      const storageRoot = storage.root || (projectsInfo && projectsInfo.storageRoot) || ''

      return h('div', { className: 'te-stack' },
        h(Card, {
          title: t('mode.current'),
          actions: h('div', { className: 'te-inline' },
            MODES.map((candidate) => h('button', {
              key: candidate,
              type: 'button',
              className: 'te-btn' + (candidate === mode ? ' te-btn-primary' : ''),
              'aria-pressed': candidate === mode,
              disabled: Boolean(busy),
              onClick: () => onSetMode(candidate),
            }, t('mode.' + candidate), candidate === mode ? h(Badge, { text: t('mode.current'), tone: modeTone(mode) }) : null)),
          ),
        },
        h('div', { className: 'te-inline' }, h(Badge, { text: t('mode.' + mode), tone: modeTone(mode) })),
        h(ModeLegend, { t }),
        ),

        h('div', { className: 'te-grid te-grid-4' },
          h(Stat, { value: num(totals.modelRequests, t, locale), label: t('overview.modelRequests') }),
          h(Stat, { value: num(totals.inputTokens, t, locale), label: t('overview.inputTokens') }),
          h(Stat, { value: num(totals.outputTokens, t, locale), label: t('overview.outputTokens') }),
          h(Stat, {
            value: totals.effectiveTokens === null || totals.effectiveTokens === undefined ? t('common.na') : num(totals.effectiveTokens, t, locale),
            label: t('overview.effectiveTokens'),
            hint: t('overview.effectiveEstimate'),
            badge: t('common.estimate'),
          }),
          h(Stat, {
            value: formatUsd(totals.costUsd, locale) || t('overview.costUnavailable'),
            label: t('overview.cost'),
            hint: costMissing.length ? t('overview.costMissing', { models: costMissing.join(', ') }) : null,
          }),
          h(Stat, {
            value: savingsValue,
            label: t('overview.savingsTokens'),
            hint: t('overview.savingsNote'),
            badge: t('common.estimate'),
          }),
          h(Stat, { value: num(prune.hiddenTools, t, locale), label: t('overview.hiddenTools') }),
          h(Stat, { value: num(micro.injectedFacts, t, locale), label: t('overview.facts') }),
          h(Stat, { value: num(micro.pendingCandidates, t, locale), label: t('overview.pendingFacts') }),
          h(Stat, {
            value: num(loop.incidents, t, locale),
            label: t('overview.loopIncidents'),
            hint: t('overview.loopRedirects') + ': ' + num(loop.redirects, t, locale),
          }),
        ),

        h('div', { className: 'te-grid te-grid-2' },
          h(Card, { title: t('overview.root') },
            h('dl', { className: 'te-kv' },
              h('dt', null, t('common.root')),
              h('dd', null, root ? h('span', { className: 'te-code' }, root) : t('overview.rootUnknown')),
              h('dt', null, t('common.session')),
              h('dd', null, st.project && st.project.id ? h('span', { className: 'te-code' }, st.project.id) : t('common.none')),
              h('dt', null, t('overview.projects')),
              h('dd', null, t('overview.projectsTracked', { n: num(knownProjects.length, t, locale) })),
              h('dt', null, t('overview.lastIncident')),
              h('dd', null, formatDate(loopsOverview.lastIncidentAt, locale) || t('time.never')),
            ),
          ),
          h(Card, { title: t('overview.budget') },
            h('dl', { className: 'te-kv' },
              h('dt', null, t('common.session')),
              h('dd', null, t('overview.budgetSession', { used: num(budget.sessionTokens, t, locale), limit: num(budget.sessionLimit, t, locale) })),
              h('dt', null, t('overview.turnLabel')),
              h('dd', null, t('overview.budgetTurn', { tokens: num(budget.turnTokens, t, locale) })),
              h('dt', null, t('overview.overhead')),
              h('dd', null, num(budget.overheadTokens, t, locale)),
            ),
          ),
          h(Card, { title: t('overview.sessions') },
            h('dl', { className: 'te-kv' },
              h('dt', null, t('overview.sessions')),
              h('dd', null, t('overview.sessionsValue', {
                observed: num(sessions.observed, t, locale),
                subagents: num(sessions.subagentSessions, t, locale),
                roots: num(sessions.attributedRoots, t, locale),
                unobserved: num(sessions.unobserved, t, locale),
              })),
              h('dt', null, t('overview.storageRoot')),
              h('dd', null, storageRoot ? h('span', { className: 'te-code' }, storageRoot) : t('common.unknown')),
            ),
          ),
          h(Card, { title: t('overview.storage') },
            h('dl', { className: 'te-kv' },
              h('dt', null, t('overview.storageRoot')),
              h('dd', null, storage.root ? h('span', { className: 'te-code' }, storage.root) : t('common.unknown')),
              h('dt', null, t('common.project')),
              h('dd', null, storage.projectDir ? h('span', { className: 'te-code' }, storage.projectDir) : t('common.none')),
              h('dt', null, t('overview.storageSize')),
              h('dd', null, t('overview.storageBytes', {
                bytes: num(storage.bytes, t, locale),
                schema: num(storage.schemaVersion, t, locale),
              })),
              h('dt', null, t('overview.storageSchema')),
              h('dd', null, num(storage.schemaVersion, t, locale)),
            ),
          ),
        ),

        h(Card, { title: t('overview.measured') },
          h('div', { className: 'te-stack' },
            h('p', { className: 'te-small te-muted', style: { margin: 0 } }, t('overview.rawNote')),
            h('p', { className: 'te-small te-muted', style: { margin: 0 } }, t('overview.effectiveNote')),
            h('p', { className: 'te-small te-muted', style: { margin: 0 } }, t('overview.savingsNote2')),
            Array.isArray(overview && overview.measurement) && overview.measurement.length
              ? h('div', null,
                h('div', { className: 'te-card-title', style: { marginTop: 4 } }, t('overview.measurementNotes')),
                h('ul', { className: 'te-stack', style: { margin: 0, paddingLeft: 18 } },
                  overview.measurement.map((entry, index) => h('li', { key: index, className: 'te-small' }, entry))),
              )
              : null,
            Array.isArray(st.notes) && st.notes.length
              ? h('div', null,
                h('div', { className: 'te-card-title', style: { marginTop: 4 } }, t('overview.pluginNotes')),
                h('ul', { className: 'te-stack', style: { margin: 0, paddingLeft: 18 } },
                  st.notes.map((entry, index) => h('li', { key: index, className: 'te-small' }, entry))),
              )
              : null,
          ),
        ),

        h(Card, { title: t('overview.recent') },
          metricRows.length === 0
            ? h(Empty, null, t('overview.recentEmpty'))
            : h(Table, {
              className: 'te-table-overview',
              columns: [
                { label: t('overview.tableTime') },
                { label: t('overview.tableTokens'), className: 'te-num' },
                { label: t('overview.tableEffective'), className: 'te-num' },
                { label: t('overview.tableCost'), className: 'te-num' },
                { label: t('overview.tableCalls'), className: 'te-num' },
                { label: t('overview.tableErrors'), className: 'te-num' },
              ],
              rows: metricRows,
            }),
        ),
      )
    }

    function FactRow({ fact, t, locale, busy, allowConfirm, onAction }) {
      const statusTone = fact.status === 'confirmed' ? 'ok' : fact.status === 'candidate' ? 'warn' : ''
      const statusLabel = labelOrRaw(t, 'fact.status.', fact.status, t('common.unknown'))
      return h('div', { className: 'te-fact' },
        h('div', { className: 'te-fact-head' },
          h('div', { className: 'te-fact-text' }, fact.text),
          h('div', { className: 'te-inline' },
            h(Badge, { text: statusLabel, tone: statusTone }),
            fact.sensitive ? h(Badge, { text: t('skills.sensitive'), tone: 'warn' }) : null,
          ),
        ),
        h('div', { className: 'te-fact-meta' },
          fact.kind ? h('span', { className: 'te-chip' }, fact.kind) : null,
          h('span', null, t('skills.confirmations', { n: num(fact.confirmations, t, locale) })),
          h('span', null, t('skills.sessions', { n: num(fact.sessionsSeen, t, locale) })),
          h('span', null, t('skills.lastSeen', { when: formatDate(fact.lastSeenAt, locale) || t('time.never') })),
          h('span', null, t('skills.source') + ': ' + (fact.source || t('common.unknown'))),
        ),
        h('div', { className: 'te-actions' },
          allowConfirm
            ? h(Button, { onClick: () => onAction({ action: 'confirm', ids: [fact.id] }), disabled: Boolean(busy) }, t('skills.confirm'))
            : null,
          h(Button, { onClick: () => onAction({ action: 'reject', ids: [fact.id] }), disabled: Boolean(busy) }, t('skills.reject')),
          h(Button, {
            variant: 'danger',
            disabled: Boolean(busy),
            onClick: () => {
              if (typeof window !== 'undefined' && !window.confirm(t('skills.deleteConfirm'))) return
              onAction({ action: 'delete', ids: [fact.id] })
            },
          }, t('skills.delete')),
        ),
      )
    }

    function SkillsTab({ data, status, t, locale, busy, onAction }) {
      const meta = data.meta || {}
      const micro = (status && status.mechanisms && status.mechanisms.microskills) || {}
      const confirmed = Array.isArray(data.confirmed) ? data.confirmed : []
      const candidates = Array.isArray(data.candidates) ? data.candidates : []
      const retired = Array.isArray(data.retired) ? data.retired : []
      const injected = typeof micro.injectedFacts === 'number' ? micro.injectedFacts : confirmed.length
      const injectionEnabled = meta.injectionEnabled === true

      return h('div', { className: 'te-stack' },
        h('div', { className: 'te-grid te-grid-3' },
          h(Stat, { value: num(injected, t, locale), label: t('skills.injected') }),
          h(Stat, { value: num(candidates.length, t, locale), label: t('skills.pending') }),
          h(Stat, { value: t('skills.budgetValue', { used: num(meta.totalTokens, t, locale), max: num(meta.maxTokens, t, locale) }), label: t('skills.budget') }),
        ),
        h('div', { className: 'te-inline' },
          h(Badge, { text: t('skills.injection') + ': ' + (injectionEnabled ? t('common.enabled') : t('common.disabled')), tone: injectionEnabled ? 'ok' : 'warn' }),
          h(Badge, { text: t('skills.maxFacts', { n: num(meta.maxFacts, t, locale) }) }),
          h(Badge, { text: t('skills.retireDays', { n: num(meta.retireDays, t, locale) }) }),
        ),
        !injectionEnabled ? h(Alert, { kind: 'warn' }, t('skills.injectionOff')) : null,
        h(Alert, null, t('skills.untrusted')),

        h(Card, { title: t('skills.candidates') },
          candidates.length === 0
            ? h(Empty, null, t('skills.candidatesEmpty'))
            : h('div', { className: 'te-stack' }, candidates.map((fact) =>
              h(FactRow, {
                key: fact.id, fact, t, locale, busy, allowConfirm: true, onAction,
              }),
            )),
        ),

        h(Card, { title: t('skills.confirmed') },
          confirmed.length === 0
            ? h(Empty, null, t('skills.confirmedEmpty'))
            : h('div', { className: 'te-stack' }, confirmed.map((fact) =>
              h(FactRow, {
                key: fact.id, fact, t, locale, busy, allowConfirm: false, onAction,
              }),
            )),
        ),

        h('details', { className: 'te-details' },
          h('summary', null, t('skills.retired') + ' (' + num(retired.length, t, locale) + ')'),
          retired.length === 0
            ? h('div', { className: 'te-small te-muted', style: { marginTop: 7 } }, t('skills.retiredEmpty'))
            : h('div', { className: 'te-stack', style: { marginTop: 7 } }, retired.map((fact) =>
              h('div', { key: fact.id, className: 'te-small' }, fact.text),
            )),
        ),
      )
    }

    function ToolsTab({ data, t, locale, busy, onAction }) {
      const hidden = Array.isArray(data.hidden) ? data.hidden : []
      const protectedNames = Array.isArray(data.protected) ? data.protected : []
      const entries = Array.isArray(data.entries) ? data.entries : []
      const mode = data.mode || 'observe'
      const rows = entries.map((entry) => {
        const calls = Number(entry.calls) || 0
        const sessions = Number(entry.sessions) || 0
        const errors = Number(entry.errors) || 0
        const fullLast = formatDate(entry.lastUsedAt, locale) || t('time.never')
        const shortLast = formatCompactDate(entry.lastUsedAt, locale) || fullLast
        const evidence = entry.evidence
          ? t('tools.evidenceValue', {
            prompts: num(entry.evidence.prompts, t, locale),
            promptsRequired: num(entry.evidence.promptsRequired, t, locale),
            sessions: num(entry.evidence.sessions, t, locale),
            sessionsRequired: num(entry.evidence.sessionsRequired, t, locale),
          })
          : null
        return [
          {
            value: h('div', { className: 'te-tool-cell' },
              h('span', { className: 'te-code' }, entry.name),
              h('span', { className: 'te-tool-reason' }, entry.reason || t('common.none')),
              evidence ? h('span', { className: 'te-tool-evidence' }, evidence) : null,
            ),
          },
          {
            value: h(Badge, {
              text: labelOrRaw(t, 'tools.status.', entry.status, t('common.unknown')),
              tone: entry.status === 'active' ? 'ok' : entry.status === 'hidden' ? 'warn' : entry.status === 'protected' ? 'brand' : '',
            }),
          },
          {
            value: h('span', { className: 'te-nowrap' },
              h('strong', null, num(calls, t, locale)),
              h('span', { className: 'te-muted' }, ' / ' + num(sessions, t, locale)),
            ),
            className: 'te-num',
            title: t('tools.callsTitle', { calls: num(calls, t, locale), sessions: num(sessions, t, locale) }),
          },
          {
            value: num(errors, t, locale),
            className: 'te-num' + (errors > 0 ? ' te-error-text' : ' te-muted'),
          },
          { value: num(entry.descriptionTokens, t, locale), className: 'te-num' },
          { value: h('span', { title: fullLast }, shortLast), className: 'te-nowrap' },
        ]
      })

      return h('div', { className: 'te-stack' },
        h(Card, { title: t('tools.mode') },
          h('div', { className: 'te-modes' }, PRUNE_MODES.map((candidate) =>
            h('button', {
              key: candidate,
              type: 'button',
              className: 'te-mode-btn' + (candidate === mode ? ' is-selected' : ''),
              'aria-pressed': candidate === mode,
              disabled: Boolean(busy),
              onClick: () => onAction({ action: 'setMode', mode: candidate }),
            },
            h('span', { className: 'te-mode-name' }, t('tools.mode.' + candidate)),
            h('span', { className: 'te-mode-hint' }, t('tools.modeHint.' + candidate)),
            )),
          ),
          data.enabled === false ? h('div', { style: { marginTop: 10 } }, h(Alert, { kind: 'warn' }, t('tools.disabledHint'))) : null,
          Array.isArray(data.notes) && data.notes.length
            ? h('ul', { className: 'te-stack', style: { margin: '10px 0 0', paddingLeft: 18 } },
              data.notes.map((note, index) => h('li', { key: index, className: 'te-small te-muted' }, note)))
            : null,
        ),

        h('div', { className: 'te-grid te-grid-3' },
          h(Stat, { value: num(hidden.length, t, locale), label: t('tools.hidden') }),
          h(Stat, { value: num(protectedNames.length, t, locale), label: t('tools.protected') }),
          h(Stat, {
            value: num(data.estimatedHiddenTokens, t, locale),
            label: t('tools.saved'),
            badge: t('common.estimate'),
            hint: t('tools.lastAudit', { when: formatDate(data.lastAuditAt, locale) || t('time.never') }),
          }),
        ),

        hidden.length === 0 ? null : h(Card, {
          title: t('tools.hidden'),
          actions: h(Button, { disabled: Boolean(busy), onClick: () => onAction({ action: 'restoreAll' }) }, t('tools.restoreAll')),
        },
        h('div', null, hidden.map((name) => h('div', { key: name, className: 'te-hidden-item' },
          h('span', { className: 'te-code' }, name),
          h(Button, { disabled: Boolean(busy), onClick: () => onAction({ action: 'restore', names: [name] }) }, t('tools.restore')),
        ))),
        ),

        h(Card, { title: t('tools.protected') },
          protectedNames.length === 0
            ? h(Empty, null, t('tools.protectedEmpty'))
            : h('details', { className: 'te-details te-protected' },
              h('summary', null, t('tools.protectedSummary', { n: num(protectedNames.length, t, locale) })),
              h('div', { className: 'te-chips' }, protectedNames.map((name) =>
                h('span', { key: name, className: 'te-code' }, name),
              )),
            ),
        ),

        h(Card, { title: t('tools.entries') },
          rows.length === 0
            ? h(Empty, null, t('tools.entriesEmpty'))
            : h(Table, {
              className: 'te-table-tools',
              columns: [
                { label: t('tools.colName') },
                { label: t('tools.colStatus') },
                { label: t('tools.colCalls'), className: 'te-num' },
                { label: t('tools.colErrors'), className: 'te-num' },
                { label: t('tools.colTokens'), className: 'te-num' },
                { label: t('tools.colLastUsed') },
              ],
              rows,
            }),
        ),
      )
    }

    function LoopIncident({ incident, t, locale }) {
      const signals = incident.signals || {}
      const judge = incident.judge || {}
      const decision = incident.decision
      const outcome = incident.outcome
      const decisionTone = decision === 'redirected' ? 'brand' : decision === 'budget-exhausted' ? 'warn' : ''
      const outcomeTone = outcome === 'recovered' ? 'ok' : outcome === 'unknown' ? '' : 'warn'
      const confidence = formatPercent(judge.confidence)
      const judgeModel = [judge.provider, judge.model].filter(Boolean).join('/')
      return h('div', { className: 'te-incident' },
        h('div', { className: 'te-incident-head' },
          h('span', { className: 'te-mono te-small' }, formatDate(incident.at, locale) || t('time.never')),
          h(Badge, { text: t('loops.level', { n: num(incident.level, t, locale) }), tone: Number(incident.level) >= 3 ? 'bad' : Number(incident.level) >= 2 ? 'warn' : '' }),
          h('span', { className: 'te-small te-muted' }, t('loops.turn', { n: num(incident.turn, t, locale) })),
          incident.sessionId ? h('span', { className: 'te-code te-small' }, incident.sessionId) : null,
          h('span', { className: 'te-small' }, t('loops.decision') + ': '),
          h(Badge, { text: labelOrRaw(t, 'loops.decision.', decision, t('common.unknown')), tone: decisionTone }),
          h('span', { className: 'te-small' }, t('loops.outcome') + ': '),
          h(Badge, { text: labelOrRaw(t, 'loops.outcome.', outcome, t('common.unknown')), tone: outcomeTone }),
        ),
        h('div', { className: 'te-incident-reason' },
          h('span', { className: 'te-muted te-small' }, t('loops.reason') + ': '),
          incident.reason || signals.reason || t('common.unknown'),
        ),
        h('div', { className: 'te-fact-meta' },
          h('span', null, t('loops.judge') + ': '),
          judge.used
            ? h('span', { className: 'te-inline' },
              h(Badge, { text: labelOrRaw(t, 'loops.judgeOutcome.', judge.outcome, t('common.unknown')), tone: judge.outcome === 'stuck' ? 'warn' : judge.outcome === 'progress' ? 'ok' : '' }),
              confidence ? h('span', null, t('loops.judgeConfidence', { value: confidence })) : null,
              judgeModel ? h('span', null, t('loops.judgeModel', { model: judgeModel })) : null,
              h('span', null, t('loops.judgeTokens', { n: num(judge.tokens, t, locale) })),
            )
            : h('span', null, t('loops.judgeNotUsed')),
        ),
        judge.error ? h('div', { className: 'te-small' }, h(Badge, { text: t('loops.judgeError', { message: judge.error }), tone: 'bad' })) : null,
        h('details', { className: 'te-details' },
          h('summary', null, t('loops.signals')),
          h('div', { className: 'te-details-body' }, t('loops.signalsValue', {
            turns: num(signals.turns, t, locale),
            errors: num(signals.errors, t, locale),
            churn: num(signals.editChurn, t, locale),
            files: num(signals.distinctEditFiles, t, locale),
            stagnation: num(signals.stagnation, t, locale),
          })),
        ),
        incident.redirectText
          ? h('details', { className: 'te-details' },
            h('summary', null, t('loops.redirect')),
            h('div', { className: 'te-details-body' }, incident.redirectText),
          )
          : null,
      )
    }

    function LoopsTab({ data, t, locale, busy, onAction }) {
      const incidents = Array.isArray(data.incidents) ? data.incidents.slice() : []
      incidents.sort((left, right) => String(right.at || '').localeCompare(String(left.at || '')))
      const summary = data.summary || {}
      const config = data.config || {}
      return h('div', { className: 'te-stack' },
        h('div', { className: 'te-grid te-grid-3' },
          h(Stat, { value: num(summary.incidents, t, locale), label: t('loops.incidents') }),
          h(Stat, { value: num(summary.redirected, t, locale), label: t('loops.redirected') }),
          h(Stat, { value: num(summary.recovered, t, locale), label: t('loops.recovered') }),
          h(Stat, { value: num(summary.judgeCalls, t, locale), label: t('loops.judgeCalls') }),
          h(Stat, { value: num(summary.judgeTokens, t, locale), label: t('loops.judgeTokensLabel') }),
          h(Stat, { value: num(summary.budgetExhausted, t, locale), label: t('loops.budgetExhausted') }),
        ),

        h(Card, { title: t('loops.config') },
          h('dl', { className: 'te-kv' },
            h('dt', null, t('loops.configEnabled')),
            h('dd', null, h(Badge, { text: config.enabled ? t('common.enabled') : t('common.disabled'), tone: config.enabled ? 'ok' : 'warn' })),
            h('dt', null, t('loops.configIntervene')),
            h('dd', null, h(Badge, { text: config.intervene ? t('common.enabled') : t('common.disabled'), tone: config.intervene ? 'warn' : '' })),
            h('dt', null, t('loops.configConfidence')),
            h('dd', null, formatPercent(config.confidence) || t('common.na')),
            h('dt', null, t('loops.configMax')),
            h('dd', null, num(config.maxInterventions, t, locale)),
            h('dt', null, t('loops.configLevel')),
            h('dd', null, enumLabel(t, config.level)),
          ),
        ),

        h(Card, {
          title: t('loops.list'),
          actions: h(Button, {
            variant: 'danger',
            disabled: Boolean(busy),
            onClick: () => {
              if (typeof window !== 'undefined' && !window.confirm(t('loops.clearConfirm'))) return
              onAction({ action: 'clear' })
            },
          }, t('loops.clear')),
        },
        incidents.length === 0
          ? h(Empty, null, t('loops.empty'))
          : h('div', { className: 'te-stack' }, incidents.map((incident) =>
            h(LoopIncident, { key: incident.id, incident, t, locale }),
          )),
        ),
      )
    }

    function editorValue(field, config) {
      const raw = config ? config[field.key] : undefined
      if (field.type === 'boolean') return raw === true
      if (field.type === 'array') return Array.isArray(raw) ? raw.join(', ') : ''
      if (raw === null || raw === undefined) return ''
      return String(raw)
    }

    function canonicalValue(field, value) {
      if (field.type === 'boolean') return Boolean(value)
      if (field.type === 'number') return Number(value)
      if (field.type === 'array') {
        return String(value).split(',').map((item) => item.trim()).filter((item) => item !== '')
      }
      return String(value)
    }

    function isValidValue(field, value) {
      if (field.type !== 'number') return true
      if (String(value).trim() === '') return false
      const number = Number(value)
      if (!Number.isFinite(number)) return false
      if (typeof field.min === 'number' && number < field.min) return false
      if (typeof field.max === 'number' && number > field.max) return false
      if (field.step === 1 && !Number.isInteger(number)) return false
      return true
    }

    function sameValue(left, right) {
      return JSON.stringify(left) === JSON.stringify(right)
    }

    function buildDraft(settings) {
      const draft = {}
      const fields = Array.isArray(settings.fields) ? settings.fields : []
      for (const field of fields) {
        draft[field.key] = editorValue(field, settings.config || {})
      }
      return draft
    }

    function SettingsTab({ settings, status, t, locale, busy, onSave, onReload }) {
      const [draft, setDraft] = React.useState(() => buildDraft(settings))
      const [openGroups, setOpenGroups] = React.useState({ general: true })
      React.useEffect(() => {
        setDraft(buildDraft(settings))
      }, [settings])

      const fields = Array.isArray(settings.fields) ? settings.fields : []
      const writable = settings.writable !== false
      const disabled = Boolean(busy) || !writable
      const changed = {}
      const invalidKeys = []
      for (const field of fields) {
        const current = draft[field.key]
        if (current === undefined) continue
        if (!isValidValue(field, current)) invalidKeys.push(field.key)
        const original = canonicalValue(field, editorValue(field, settings.config || {}))
        const next = canonicalValue(field, current)
        if (!sameValue(original, next)) changed[field.key] = next
      }
      const dirty = Object.keys(changed).length > 0
      const canSave = writable && !busy && dirty && invalidKeys.length === 0
      const invalidSignature = invalidKeys.join('|')
      React.useEffect(() => {
        if (!invalidSignature) return
        const groupsToOpen = {}
        for (const field of fields) {
          if (invalidKeys.indexOf(field.key) !== -1) groupsToOpen[field.group || 'other'] = true
        }
        setOpenGroups((previous) => {
          let changedOpenState = false
          const next = Object.assign({}, previous)
          for (const group of Object.keys(groupsToOpen)) {
            if (!next[group]) {
              next[group] = true
              changedOpenState = true
            }
          }
          return changedOpenState ? next : previous
        })
      }, [invalidSignature])

      const plugin = (status && status.plugin) || {}
      const compatibility = settings.compatibility || plugin.compatibility || null
      const readOnlyReason = compatibility && compatibility.reason ? compatibility.reason : t('common.unknown')

      const groupOrder = []
      const groupFields = {}
      for (const field of fields) {
        const group = field.group || 'other'
        if (!groupFields[group]) {
          groupFields[group] = []
          groupOrder.push(group)
        }
        groupFields[group].push(field)
      }

      function setGroupOpen(group, open) {
        setOpenGroups((previous) => (previous[group] === open ? previous : Object.assign({}, previous, { [group]: open })))
      }

      function setAllGroups(open) {
        const next = {}
        for (const group of groupOrder) next[group] = open
        setOpenGroups(next)
      }

      function updateField(key, value) {
        setDraft((previous) => {
          const next = Object.assign({}, previous)
          next[key] = value
          return next
        })
      }

      function renderField(field) {
        const value = draft[field.key]
        const isChanged = Object.prototype.hasOwnProperty.call(changed, field.key)
        const isInvalid = invalidKeys.indexOf(field.key) !== -1
        const help = fieldHint(t, field.key)
          || (field.type === 'array' ? t('settings.arrayHint') : field.type === 'secret' ? t('settings.secretHint') : null)
        const title = fieldLabel(t, field.key) + (field.advanced ? ' · ' + t('common.advanced') : '')

        if (field.type === 'boolean') {
          return h('div', { key: field.key, className: 'te-field' },
            h(Toggle, {
              checked: Boolean(value),
              disabled,
              title: title + (isChanged ? ' · ' + t('settings.changed') : ''),
              hint: help,
              onChange: (checked) => updateField(field.key, checked),
            }),
          )
        }

        let control
        if (field.type === 'enum') {
          const options = Array.isArray(field.options) ? field.options : []
          control = h('select', {
            className: 'te-select',
            value: typeof value === 'string' ? value : '',
            disabled,
            onChange: (event) => updateField(field.key, event.target.value),
          }, options.map((option) => h('option', { key: option, value: option }, enumLabel(t, option))))
        } else if (field.type === 'number') {
          control = h('input', {
            className: 'te-input',
            type: 'number',
            value: typeof value === 'string' ? value : String(value === undefined ? '' : value),
            min: typeof field.min === 'number' ? field.min : undefined,
            max: typeof field.max === 'number' ? field.max : undefined,
            step: typeof field.step === 'number' ? String(field.step) : 'any',
            disabled,
            onChange: (event) => updateField(field.key, event.target.value),
          })
        } else if (field.type === 'secret') {
          control = h('input', {
            className: 'te-input',
            type: 'password',
            value: typeof value === 'string' ? value : '',
            disabled,
            autoComplete: 'off',
            onChange: (event) => updateField(field.key, event.target.value),
          })
        } else {
          control = h('input', {
            className: 'te-input',
            type: 'text',
            value: typeof value === 'string' ? value : String(value === undefined ? '' : value),
            disabled,
            onChange: (event) => updateField(field.key, event.target.value),
          })
        }

        return h('div', { key: field.key, className: 'te-field' },
          h('div', { className: 'te-field-head' },
            h('label', null, title),
            isChanged ? h(Badge, { text: t('settings.changed'), tone: 'brand' }) : null,
          ),
          help ? h('div', { className: 'te-field-help' }, help) : null,
          control,
          isInvalid ? h('div', { className: 'te-field-error' }, t('settings.fieldInvalid')) : null,
        )
      }

      return h('div', { className: 'te-stack' },
        h(Card, { title: t('settings.title') },
          h('dl', { className: 'te-kv' },
            h('dt', null, t('settings.pluginVersion')),
            h('dd', null, plugin.version || t('common.unknown')),
            h('dt', null, t('settings.dshVersion')),
            h('dd', null, plugin.dshVersion || t('common.unknown')),
            h('dt', null, t('settings.compat')),
            h('dd', null, compatibility
              ? h('span', { className: 'te-inline' },
                h(Badge, {
                  text: compatibility.ok ? t('settings.compatOk') : t('settings.compatFail'),
                  tone: compatibility.ok ? 'ok' : 'bad',
                }),
                h('span', { className: 'te-small te-muted' }, t('settings.compatReason', { reason: compatibility.reason || t('common.unknown') })),
                compatibility.testedRange ? h('span', { className: 'te-small te-muted' }, t('settings.testedRange', { range: compatibility.testedRange })) : null,
                compatibility.version ? h('span', { className: 'te-small te-muted' }, t('common.version') + ': ' + compatibility.version) : null,
              )
              : t('common.unknown')),
            h('dt', null, t('settings.revision')),
            h('dd', null, settings.revision === null || settings.revision === undefined ? t('common.na') : String(settings.revision)),
          ),
        ),
        !writable ? h(Alert, { kind: 'warn' }, t('settings.readOnly', { reason: readOnlyReason })) : null,
        Array.isArray(settings.notes) && settings.notes.length
          ? h(Card, { title: t('settings.notes') },
            h('ul', { className: 'te-stack', style: { margin: 0, paddingLeft: 18 } },
              settings.notes.map((note, index) => h('li', { key: index, className: 'te-small te-muted' }, note))),
          )
          : null,
        groupOrder.length === 0
          ? h(Empty, null, t('common.na'))
          : h('div', null,
            h('div', { className: 'te-group-controls', style: { marginBottom: 8 } },
              h(Button, { variant: 'ghost', disabled: Boolean(busy), onClick: () => setAllGroups(true) }, t('settings.expandAll')),
              h(Button, { variant: 'ghost', disabled: Boolean(busy), onClick: () => setAllGroups(false) }, t('settings.collapseAll')),
            ),
            h('div', { className: 'te-stack' }, groupOrder.map((group) => {
              const list = groupFields[group]
              const changedCount = list.filter((field) => Object.prototype.hasOwnProperty.call(changed, field.key)).length
              const invalidCount = list.filter((field) => invalidKeys.indexOf(field.key) !== -1).length
              const isOpen = openGroups[group] === true
              return h('details', {
                key: group,
                className: 'te-settings-group',
                open: isOpen,
                onToggle: (event) => setGroupOpen(group, event.currentTarget.open),
              },
              h('summary', { className: 'te-group-summary' },
                h('span', { className: 'te-group-title' }, groupLabel(t, group)),
                h('span', { className: 'te-group-meta' },
                  t('settings.groupFields', { n: list.length })
                    + (changedCount ? ' · ' + t('settings.groupChanged', { n: changedCount }) : '')
                    + (invalidCount ? ' · ' + t('settings.groupInvalid', { n: invalidCount }) : ''),
                ),
              ),
                h('div', { className: 'te-form' }, list.map((field) => renderField(field))),
              )
            })),
          ),
        h('div', { className: 'te-savebar' },
          h('div', { className: 'te-savebar-info' },
            invalidKeys.length
              ? h(Alert, { kind: 'error' }, t('settings.invalid'))
              : dirty
                ? t('settings.pending')
                : t('settings.clean'),
          ),
          h('div', { className: 'te-actions' },
            h(Button, { disabled: Boolean(busy), onClick: onReload }, t('common.reload')),
            h(Button, { variant: 'primary', disabled: !canSave, onClick: () => onSave(changed) }, t('settings.save')),
          ),
        ),
      )
    }

    function App(props) {
      const ctx = props.pluginContext
      const revision = useLocaleRevision(ctx)
      const t = React.useMemo(() => bindT(ctx), [ctx, revision])
      const locale = (ctx.locale && ctx.locale.getSnapshot ? ctx.locale.getSnapshot().active : 'en') || 'en'

      const sessionId = props.shellSessionId || ''
      const cwd = props.shellCwd || ''
      const scope = React.useMemo(() => ({ sessionId, cwd }), [sessionId, cwd])

      const [tab, setTab] = React.useState('overview')
      const [status, setStatus] = React.useState(null)
      const [overview, setOverview] = React.useState(null)
      const [skills, setSkills] = React.useState(null)
      const [tools, setTools] = React.useState(null)
      const [loops, setLoops] = React.useState(null)
      const [settings, setSettings] = React.useState(null)
      const [projectsInfo, setProjectsInfo] = React.useState({ projects: [], storageRoot: '' })
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState(null)

      const tRef = React.useRef(t)
      React.useEffect(() => { tRef.current = t }, [t])
      const tabRef = React.useRef(tab)
      React.useEffect(() => { tabRef.current = tab }, [tab])

      const notify = React.useCallback((message, kind) => {
        setNotice({ message, kind: kind || 'error' })
        if (kind === 'ok') {
          window.setTimeout(() => setNotice((current) => (current && current.message === message ? null : current)), 3500)
        }
      }, [])

      const loadOverview = React.useCallback(async (options) => {
        const opts = options || {}
        try {
          const [nextStatus, nextOverview] = await Promise.all([
            apiGet('/status', scope),
            apiGet('/overview', scope),
          ])
          setStatus(nextStatus)
          setOverview(nextOverview)
          setError('')
          return true
        } catch (loadError) {
          if (!opts.silent) setError(tRef.current('error.load', { message: loadError.message }))
          return false
        }
      }, [scope])

      const loadSkills = React.useCallback(async (options) => {
        const opts = options || {}
        try {
          const next = await apiGet('/skills', scope)
          setSkills(next)
          setError('')
          return true
        } catch (loadError) {
          if (!opts.silent) setError(tRef.current('error.load', { message: loadError.message }))
          return false
        }
      }, [scope])

      const loadTools = React.useCallback(async (options) => {
        const opts = options || {}
        try {
          const next = await apiGet('/tools', scope)
          setTools(next)
          setError('')
          return true
        } catch (loadError) {
          if (!opts.silent) setError(tRef.current('error.load', { message: loadError.message }))
          return false
        }
      }, [scope])

      const loadLoops = React.useCallback(async (options) => {
        const opts = options || {}
        try {
          const next = await apiGet('/loops', scope)
          setLoops(next)
          setError('')
          return true
        } catch (loadError) {
          if (!opts.silent) setError(tRef.current('error.load', { message: loadError.message }))
          return false
        }
      }, [scope])

      const loadSettings = React.useCallback(async (options) => {
        const opts = options || {}
        try {
          const next = await apiGet('/settings')
          setSettings(next)
          setError('')
          return true
        } catch (loadError) {
          if (!opts.silent) setError(tRef.current('error.noSettings', { message: loadError.message }))
          return false
        }
      }, [])

      const loadProjects = React.useCallback(async (options) => {
        const opts = options || {}
        try {
          const next = await apiGet('/projects')
          setProjectsInfo({
            projects: Array.isArray(next.projects) ? next.projects : [],
            storageRoot: next.storageRoot || '',
          })
          return true
        } catch (loadError) {
          if (!opts.silent) setError(tRef.current('error.load', { message: loadError.message }))
          return false
        }
      }, [])

      const loadTab = React.useCallback((name, options) => {
        if (name === 'skills') return loadSkills(options)
        if (name === 'tools') return loadTools(options)
        if (name === 'loops') return loadLoops(options)
        if (name === 'settings') return loadSettings(options)
        return loadOverview(options)
      }, [loadOverview, loadSkills, loadTools, loadLoops, loadSettings])

      React.useEffect(() => {
        let alive = true
        setLoading(true)
        Promise.allSettled([loadOverview(), loadSettings(), loadProjects()]).then(() => {
          if (alive) setLoading(false)
        })
        return () => { alive = false }
      }, [loadOverview, loadSettings, loadProjects])

      React.useEffect(() => {
        if (loading) return undefined
        const timer = window.setTimeout(() => { loadTab(tab, { silent: true }) }, 0)
        return () => window.clearTimeout(timer)
      }, [tab, loading, loadTab])

      React.useEffect(() => {
        const timer = window.setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          loadTab(tabRef.current, { silent: true })
        }, 30000)
        return () => window.clearInterval(timer)
      }, [loadTab])

      const reloadActive = React.useCallback(() => {
        setError('')
        return loadTab(tabRef.current, {})
      }, [loadTab])

      const refreshAfterAction = React.useCallback(async (target) => {
        await loadOverview({ silent: true })
        if (target && target !== 'overview') await loadTab(target, { silent: true })
      }, [loadOverview, loadTab])

      const runSkillsAction = React.useCallback(async (payload) => {
        setBusy(tRef.current('common.saving'))
        setNotice(null)
        try {
          await apiPost('/skills/action', Object.assign({}, payload, scope))
          await refreshAfterAction('skills')
          notify(tRef.current('common.done'), 'ok')
          return true
        } catch (actionError) {
          notify(tRef.current('error.action', { message: actionError.message }), 'error')
          return false
        } finally {
          setBusy('')
        }
      }, [scope, refreshAfterAction, notify])

      const runToolsAction = React.useCallback(async (payload) => {
        setBusy(tRef.current('common.saving'))
        setNotice(null)
        try {
          await apiPost('/tools/action', Object.assign({}, payload, scope))
          await refreshAfterAction('tools')
          notify(tRef.current('common.done'), 'ok')
          return true
        } catch (actionError) {
          notify(tRef.current('error.action', { message: actionError.message }), 'error')
          return false
        } finally {
          setBusy('')
        }
      }, [scope, refreshAfterAction, notify])

      const runLoopsAction = React.useCallback(async (payload) => {
        setBusy(tRef.current('common.saving'))
        setNotice(null)
        try {
          await apiPost('/loops/action', Object.assign({}, payload, scope))
          await refreshAfterAction('loops')
          notify(tRef.current('common.done'), 'ok')
          return true
        } catch (actionError) {
          notify(tRef.current('error.action', { message: actionError.message }), 'error')
          return false
        } finally {
          setBusy('')
        }
      }, [scope, refreshAfterAction, notify])

      const setMode = React.useCallback(async (mode) => {
        setBusy(tRef.current('common.saving'))
        setNotice(null)
        try {
          await apiPost('/mode', { mode })
          await refreshAfterAction('overview')
          notify(tRef.current('common.done'), 'ok')
          return true
        } catch (actionError) {
          notify(tRef.current('error.action', { message: actionError.message }), 'error')
          return false
        } finally {
          setBusy('')
        }
      }, [refreshAfterAction, notify])

      const saveSettings = React.useCallback(async (patch) => {
        setBusy(tRef.current('common.saving'))
        setNotice(null)
        try {
          const result = await apiPost('/settings', { patch })
          if (result && Array.isArray(result.fields)) setSettings(result)
          else await loadSettings()
          await loadOverview({ silent: true })
          notify(tRef.current('settings.saved'), 'ok')
          return true
        } catch (actionError) {
          notify(tRef.current('error.action', { message: actionError.message }), 'error')
          return false
        } finally {
          setBusy('')
        }
      }, [loadSettings, loadOverview, notify])

      const tabs = [
        ['overview', 'tabs.overview'],
        ['skills', 'tabs.skills'],
        ['tools', 'tabs.tools'],
        ['loops', 'tabs.loops'],
        ['settings', 'tabs.settings'],
      ]

      const currentStatus = status || (overview && overview.status) || null

      function renderTab() {
        if (tab === 'overview') {
          if (!overview) return h(Empty, null, t('overview.recentEmpty'))
          return h(OverviewTab, {
            overview, status: currentStatus, projectsInfo, cwd, t, locale, busy,
            onSetMode: setMode,
          })
        }
        if (tab === 'skills') {
          if (!skills) return h(Empty, null, error || t('common.loading'))
          return h(SkillsTab, {
            data: skills, status: currentStatus, t, locale, busy,
            onAction: runSkillsAction,
          })
        }
        if (tab === 'tools') {
          if (!tools) return h(Empty, null, error || t('common.loading'))
          return h(ToolsTab, { data: tools, t, locale, busy, onAction: runToolsAction })
        }
        if (tab === 'loops') {
          if (!loops) return h(Empty, null, error || t('common.loading'))
          return h(LoopsTab, { data: loops, t, locale, busy, onAction: runLoopsAction })
        }
        if (!settings) return h(Empty, null, error || t('common.loading'))
        return h(SettingsTab, {
          settings, status: currentStatus, t, locale, busy,
          onSave: saveSettings,
          onReload: () => { setError(''); loadSettings({}) },
        })
      }

      if (!ctx || !ctx.locale) {
        return h('div', { className: 'te-root' }, h(Empty, null, 'locale service unavailable'))
      }

      return h('div', { className: 'te-root' },
        h('div', { className: 'te-head' },
          h('div', null,
            h('h2', { className: 'te-title' }, t('title')),
            h('p', { className: 'te-sub' }, t('subtitle')),
          ),
          h('div', { className: 'te-head-actions' },
            h(Button, { onClick: reloadActive, disabled: loading || Boolean(busy) }, t('common.refresh')),
          ),
        ),
        h('div', { className: 'te-tabs', role: 'tablist' }, tabs.map(([id, key]) =>
          h('button', {
            key: id,
            type: 'button',
            role: 'tab',
            id: 'te-tab-' + id,
            className: 'te-tab',
            'aria-selected': tab === id,
            onClick: () => setTab(id),
          }, t(key)),
        )),
        error ? h(Alert, { kind: 'error' }, error) : null,
        notice
          ? h('div', { className: 'te-alert ' + (notice.kind === 'ok' ? 'te-alert-ok' : notice.kind === 'warn' ? 'te-alert-warn' : 'te-alert-error') },
            h('div', { className: 'te-inline' },
              h('span', null, notice.message),
              h('span', { className: 'te-right' }, h(Button, { variant: 'ghost', onClick: () => setNotice(null) }, t('common.dismiss'))),
            ),
          )
          : null,
        !sessionId ? h(Alert, { kind: 'warn' }, t('error.noSession')) : null,
        loading
          ? h(Loading, { t })
          : h('div', { role: 'tabpanel', id: 'te-panel-' + tab, 'aria-labelledby': 'te-tab-' + tab }, renderTab()),
      )
    }

    return {
      name: 'dsh-token-economizer',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, ru }), 'token-economizer: dictionaries')
        ctx.effect(() => mountStyle(), 'token-economizer: styles')
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'token-economizer',
          order: 36,
          label: () => ctx.locale.bind(NS)('nav'),
          locale: NS,
        }, (props) => h(Root, Object.assign({}, props, { pluginContext: ctx }))))
      },
    }
  },
})
