/**
 * Telemetria STM32F103RB + Acelerômetro ADXL345 + LCD 16x2 I2C
 * Suporta:
 *  1. Conexão Direta via Cabo USB (Web Serial API - USART2 @ 115200 bps)
 *  2. Transmissão e Visualização Remota em Qualquer Lugar (MQTT over WebSockets WSS)
 *  3. Modo Simulador Integrado
 */

(() => {
  'use strict';

  const G_TO_MS2 = 9.80665;
  const MAX_HISTORY_POINTS = 220;
  const MAX_LOG_LINES = 180;
  const MQTT_BROKER_URL = 'wss://broker.hivemq.com:8884/mqtt';
  const MQTT_TOPIC_PREFIX = 'senai/stm32f103rb/adxl345/v1/';

  // Estado da Aplicação
  const state = {
    mode: 'disconnected', // 'disconnected' | 'serial' | 'remote' | 'simulated'
    port: null,
    reader: null,
    keepReading: false,
    simInterval: null,
    mqttClient: null,
    mqttConnected: false,
    subscribedTopic: null,

    // Última leitura bruta e calibrada (em g)
    raw: { x: 0, y: 0, z: 0 },
    tare: { x: 0, y: 0, z: 0, active: false },
    current: { x: 0, y: 0, z: 0, mag: 0, pitch: 0, roll: 0 },

    // Histórico do gráfico e gravação CSV
    history: [],
    recordedRows: [],
    chartPaused: false,
    chartScaleG: 4,

    // Métricas de taxa (Hz)
    sampleCount: 0,
    samplesInWindow: 0,
    lastRateCalcTime: performance.now(),
    sampleRateHz: 0
  };

  // Referências de DOM
  const el = {
    statusPill: document.getElementById('connectionStatusPill'),
    statusText: document.getElementById('connectionStatusText'),
    sampleRate: document.getElementById('sampleRateValue'),
    sampleCount: document.getElementById('sampleCountValue'),

    baudRateSelect: document.getElementById('baudRateSelect'),
    btnConnectSerial: document.getElementById('btnConnectSerial'),
    btnSimulate: document.getElementById('btnSimulate'),
    webSerialWarning: document.getElementById('webSerialWarning'),

    roomInput: document.getElementById('roomInput'),
    btnWatchRemote: document.getElementById('btnWatchRemote'),
    btnCopyShareLink: document.getElementById('btnCopyShareLink'),
    chkAutoBroadcast: document.getElementById('chkAutoBroadcast'),
    mqttStatusBadge: document.getElementById('mqttStatusBadge'),

    valXg: document.getElementById('valXg'),
    valYg: document.getElementById('valYg'),
    valZg: document.getElementById('valZg'),
    valXms2: document.getElementById('valXms2'),
    valYms2: document.getElementById('valYms2'),
    valZms2: document.getElementById('valZms2'),
    barX: document.getElementById('barX'),
    barY: document.getElementById('barY'),
    barZ: document.getElementById('barZ'),

    valMagG: document.getElementById('valMagG'),
    valMagMs2: document.getElementById('valMagMs2'),
    valPitch: document.getElementById('valPitch'),
    valRoll: document.getElementById('valRoll'),

    lcdScreen: document.getElementById('lcdScreen'),
    lcdRow0: document.getElementById('lcdRow0'),
    lcdRow1: document.getElementById('lcdRow1'),
    btnToggleLcdColor: document.getElementById('btnToggleLcdColor'),

    btnTare: document.getElementById('btnTare'),
    btnResetTare: document.getElementById('btnResetTare'),
    tareStatusText: document.getElementById('tareStatusText'),

    board3d: document.getElementById('board3d'),
    canvas: document.getElementById('telemetryCanvas'),
    chartScaleSelect: document.getElementById('chartScaleSelect'),
    btnPauseChart: document.getElementById('btnPauseChart'),
    btnClearChart: document.getElementById('btnClearChart'),

    serialTerminal: document.getElementById('serialTerminal'),
    chkAutoScroll: document.getElementById('chkAutoScroll'),
    btnExportCsv: document.getElementById('btnExportCsv'),
    btnClearLog: document.getElementById('btnClearLog')
  };

  const ctx = el.canvas.getContext('2d');
  const logLines = [];

  // =========================================================================
  // 1. PARSER RESILIENTE DE PACOTES DO STM32 (JSON, CSV ou Chave-Valor)
  // =========================================================================
  function parseTelemetryLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;

    // 1) Formato JSON enviado pelo main.c: {"x":0.12,"y":-0.04,"z":0.98}
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const obj = JSON.parse(trimmed);
        if (obj.status) {
          appendTerminalLog(`[STATUS STM32] ${trimmed}`);
          return null;
        }
        const x = Number(obj.x ?? obj.X);
        const y = Number(obj.y ?? obj.Y);
        const z = Number(obj.z ?? obj.Z);
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
          return { x, y, z };
        }
      } catch (_) {
        // Continua para os outros formatos caso o JSON tenha sido truncado
      }
    }

    // 2) Formato Texto/LCD: "x- 0.12 y- -0.04 z- 0.98" ou "X:0.12 Y:-0.04 Z:0.98"
    const kvMatch = trimmed.match(
      /x\s*[:=-]\s*([+-]?\d+(?:\.\d+)?).*?y\s*[:=-]\s*([+-]?\d+(?:\.\d+)?).*?z\s*[:=-]\s*([+-]?\d+(?:\.\d+)?)/i
    );
    if (kvMatch) {
      return {
        x: parseFloat(kvMatch[1]),
        y: parseFloat(kvMatch[2]),
        z: parseFloat(kvMatch[3])
      };
    }

    // 3) Formato CSV simples: "0.12,-0.04,0.98" ou "0.12;-0.04;0.98"
    const parts = trimmed.split(/[,;\t]+/);
    if (parts.length >= 3) {
      const x = parseFloat(parts[0]);
      const y = parseFloat(parts[1]);
      const z = parseFloat(parts[2]);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
        return { x, y, z };
      }
    }

    return null;
  }

  // =========================================================================
  // 2. PROCESSAMENTO MATEMÁTICO E ATUALIZAÇÃO DA INTERFACE
  // =========================================================================
  function processSample(rawX, rawY, rawZ, sourceTag = 'UART') {
    state.raw.x = rawX;
    state.raw.y = rawY;
    state.raw.z = rawZ;

    const x = state.tare.active ? rawX - state.tare.x : rawX;
    const y = state.tare.active ? rawY - state.tare.y : rawY;
    const z = state.tare.active ? rawZ - state.tare.z : rawZ;

    const mag = Math.sqrt(x * x + y * y + z * z);

    // Cálculo de Roll e Pitch em graus
    const roll = Math.atan2(y, z) * (180 / Math.PI);
    const pitch = Math.atan2(-x, Math.sqrt(y * y + z * z)) * (180 / Math.PI);

    state.current = { x, y, z, mag, pitch, roll };
    state.sampleCount++;
    state.samplesInWindow++;

    const nowIso = new Date().toISOString();

    if (!state.chartPaused) {
      state.history.push({ t: performance.now(), x, y, z });
      if (state.history.length > MAX_HISTORY_POINTS) {
        state.history.shift();
      }
    }

    // Guarda até 10.000 amostras para exportação CSV
    if (state.recordedRows.length < 10000) {
      state.recordedRows.push({
        timestamp: nowIso,
        x: x.toFixed(3),
        y: y.toFixed(3),
        z: z.toFixed(3),
        mag: mag.toFixed(3),
        pitch: pitch.toFixed(1),
        roll: roll.toFixed(1)
      });
    }

    updateDashboardUI();

    // Se for leitura local (Serial USB ou Simulador) e o broadcast estiver ativo, publica via WSS
    if ((sourceTag === 'UART' || sourceTag === 'SIM') && el.chkAutoBroadcast.checked) {
      publishLiveSample(x, y, z);
    }
  }

  function updateGaugeBar(barElement, valueG, maxG = 4) {
    const clamped = Math.max(-maxG, Math.min(maxG, valueG));
    const pct = (Math.abs(clamped) / maxG) * 50;
    if (clamped >= 0) {
      barElement.style.left = '50%';
      barElement.style.width = `${pct}%`;
    } else {
      barElement.style.left = `${50 - pct}%`;
      barElement.style.width = `${pct}%`;
    }
  }

  function formatLcdRow0(x, y) {
    // Reproduz exatamente:
    // HD44780_SetCursor(0,0); HD44780_PrintStr("x- "); display_data(xg);
    // HD44780_SetCursor(8,0); HD44780_PrintStr("y- "); display_data(yg);
    const col0 = `x- ${x.toFixed(2)}`.padEnd(8, ' ').slice(0, 8);
    const col8 = `y- ${y.toFixed(2)}`.padEnd(8, ' ').slice(0, 8);
    return col0 + col8;
  }

  function formatLcdRow1(z) {
    // Reproduz exatamente:
    // HD44780_SetCursor(5,1); HD44780_PrintStr("z- "); display_data(zg);
    const prefix = '     ';
    const content = `z- ${z.toFixed(2)}`;
    return (prefix + content).padEnd(16, ' ').slice(0, 16);
  }

  function updateDashboardUI() {
    const { x, y, z, mag, pitch, roll } = state.current;

    el.valXg.textContent = x.toFixed(2);
    el.valYg.textContent = y.toFixed(2);
    el.valZg.textContent = z.toFixed(2);

    el.valXms2.textContent = `${(x * G_TO_MS2).toFixed(2)} m/s²`;
    el.valYms2.textContent = `${(y * G_TO_MS2).toFixed(2)} m/s²`;
    el.valZms2.textContent = `${(z * G_TO_MS2).toFixed(2)} m/s²`;

    updateGaugeBar(el.barX, x, state.chartScaleG);
    updateGaugeBar(el.barY, y, state.chartScaleG);
    updateGaugeBar(el.barZ, z, state.chartScaleG);

    el.valMagG.textContent = mag.toFixed(2);
    el.valMagMs2.textContent = `${(mag * G_TO_MS2).toFixed(2)} m/s²`;
    el.valPitch.textContent = `${pitch.toFixed(1)}°`;
    el.valRoll.textContent = `${roll.toFixed(1)}°`;

    // Atualiza o Espelho do LCD 16x2
    el.lcdRow0.textContent = formatLcdRow0(x, y);
    el.lcdRow1.textContent = formatLcdRow1(z);

    // Atualiza a placa 3D
    el.board3d.style.transform = `rotateX(${(20 - pitch).toFixed(1)}deg) rotateY(-20deg) rotateZ(${(-roll).toFixed(1)}deg)`;

    // Contador total de amostras
    el.sampleCount.textContent = state.sampleCount.toLocaleString('pt-BR');
  }

  function appendTerminalLog(line) {
    const timeStr = new Date().toLocaleTimeString('pt-BR', { hour12: false });
    logLines.push(`[${timeStr}] ${line}`);
    if (logLines.length > MAX_LOG_LINES) {
      logLines.shift();
    }
    el.serialTerminal.textContent = logLines.join('\n');
    if (el.chkAutoScroll.checked) {
      el.serialTerminal.scrollTop = el.serialTerminal.scrollHeight;
    }
  }

  // =========================================================================
  // 3. CONEXÃO WEB SERIAL API (CABO USB -> STM32 USART2)
  // =========================================================================
  async function connectWebSerial() {
    if (!('serial' in navigator)) {
      el.webSerialWarning.classList.remove('hidden');
      alert('Seu navegador não suporta a Web Serial API. Utilize Google Chrome ou Microsoft Edge no computador, ou use o botão "Assistir Sala Remota".');
      return;
    }

    if (state.mode === 'serial') {
      await disconnectWebSerial();
      return;
    }

    await stopAllModes();

    try {
      const baudRate = parseInt(el.baudRateSelect.value, 10) || 115200;
      const port = await navigator.serial.requestPort();
      await port.open({
        baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none'
      });

      state.port = port;
      state.keepReading = true;
      setConnectionState('serial', `STM32 Conectado (${baudRate} bps)`);
      appendTerminalLog(`Porta Serial aberta em ${baudRate} bps (8N1). Aguardando dados da USART2...`);

      // Garante que o cliente MQTT esteja ativo para retransmitir à nuvem se marcado
      ensureMqttConnection();

      readSerialLoop(port);
    } catch (err) {
      appendTerminalLog(`Erro ao abrir porta serial: ${err.message}`);
      setConnectionState('disconnected', 'Desconectado');
    }
  }

  async function readSerialLoop(port) {
    let lineBuffer = '';
    const textDecoder = new TextDecoder();

    while (port.readable && state.keepReading) {
      const reader = port.readable.getReader();
      state.reader = reader;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            lineBuffer += textDecoder.decode(value, { stream: true });
            const lines = lineBuffer.split(/\r?\n/);
            lineBuffer = lines.pop() || '';

            for (const rawLine of lines) {
              const trimmed = rawLine.trim();
              if (!trimmed) continue;
              appendTerminalLog(trimmed);
              const parsed = parseTelemetryLine(trimmed);
              if (parsed) {
                processSample(parsed.x, parsed.y, parsed.z, 'UART');
              }
            }
          }
        }
      } catch (err) {
        if (state.keepReading) {
          appendTerminalLog(`Leitura serial interrompida: ${err.message}`);
        }
      } finally {
        reader.releaseLock();
        state.reader = null;
      }
    }
  }

  async function disconnectWebSerial() {
    state.keepReading = false;
    try {
      if (state.reader) {
        await state.reader.cancel();
      }
      if (state.port) {
        await state.port.close();
      }
    } catch (_) {
      // Ignora erro de fechamento
    }
    state.port = null;
    state.reader = null;
    setConnectionState('disconnected', 'Desconectado');
    appendTerminalLog('Porta Serial USB desconectada.');
  }

  // =========================================================================
  // 4. TRANSMISSÃO E RECEPÇÃO REMOTA EM TEMPO REAL (MQTT OVER WEBSOCKETS)
  // =========================================================================
  function getCleanRoomTopic() {
    const room = (el.roomInput.value || 'senai-stm32-f103rb')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-');
    return `${MQTT_TOPIC_PREFIX}${room}`;
  }

  function ensureMqttConnection(onConnectedCallback) {
    if (typeof window.mqtt === 'undefined') {
      el.mqttStatusBadge.textContent = 'Relay: Offline';
      return;
    }

    if (state.mqttClient && state.mqttConnected) {
      if (onConnectedCallback) onConnectedCallback();
      return;
    }

    if (state.mqttClient) {
      if (onConnectedCallback) {
        state.mqttClient.once('connect', onConnectedCallback);
      }
      return;
    }

    el.mqttStatusBadge.textContent = 'Relay: Conectando...';
    const clientId = `stm32_web_${Math.random().toString(16).slice(2, 10)}`;
    const client = window.mqtt.connect(MQTT_BROKER_URL, {
      clientId,
      clean: true,
      connectTimeout: 8000,
      reconnectPeriod: 3000
    });

    state.mqttClient = client;

    client.on('connect', () => {
      state.mqttConnected = true;
      el.mqttStatusBadge.textContent = 'Relay Nuvem: Online (WSS)';
      if (onConnectedCallback) onConnectedCallback();
    });

    client.on('error', () => {
      el.mqttStatusBadge.textContent = 'Relay: Erro de rede';
    });

    client.on('close', () => {
      state.mqttConnected = false;
      el.mqttStatusBadge.textContent = 'Relay: Reconectando...';
    });

    client.on('message', (topic, payload) => {
      if (state.mode !== 'remote' || topic !== state.subscribedTopic) return;
      const msgStr = payload.toString();
      appendTerminalLog(`[LIVE REMOTO] ${msgStr}`);
      const parsed = parseTelemetryLine(msgStr);
      if (parsed) {
        processSample(parsed.x, parsed.y, parsed.z, 'REMOTE');
      }
    });
  }

  function publishLiveSample(x, y, z) {
    ensureMqttConnection();
    if (!state.mqttClient || !state.mqttConnected) return;
    const topic = getCleanRoomTopic();
    const payload = JSON.stringify({
      x: Number(x.toFixed(2)),
      y: Number(y.toFixed(2)),
      z: Number(z.toFixed(2)),
      ts: Date.now()
    });
    state.mqttClient.publish(topic, payload, { qos: 0, retain: false });
  }

  async function toggleWatchRemoteRoom() {
    if (state.mode === 'remote') {
      await stopAllModes();
      return;
    }

    await stopAllModes();
    const topic = getCleanRoomTopic();
    const roomName = el.roomInput.value.trim() || 'senai-stm32-f103rb';

    setConnectionState('remote', `Assistindo Sala: ${roomName}`);
    appendTerminalLog(`Conectando à Sala Remota "${roomName}" em tempo real via WebSockets...`);

    ensureMqttConnection(() => {
      if (state.subscribedTopic) {
        state.mqttClient.unsubscribe(state.subscribedTopic);
      }
      state.mqttClient.subscribe(topic, { qos: 0 }, (err) => {
        if (!err) {
          state.subscribedTopic = topic;
          appendTerminalLog(`Inscrito na sala "${roomName}". Recebendo leituras do STM32 em tempo real!`);
        } else {
          appendTerminalLog(`Falha ao entrar na sala remota: ${err.message}`);
        }
      });
    });
  }

  // =========================================================================
  // 5. MODO SIMULADOR (PARA TESTES SEM HARDWARE FÍSICO)
  // =========================================================================
  async function toggleSimulator() {
    if (state.mode === 'simulated') {
      await stopAllModes();
      return;
    }

    await stopAllModes();
    setConnectionState('simulated', 'Modo Simulador Ativo (10 Hz)');
    appendTerminalLog('Modo Simulador iniciado. Gerando pacotes JSON idênticos ao STM32F103RB...');
    ensureMqttConnection();

    let t = 0;
    state.simInterval = setInterval(() => {
      t += 0.1;
      const simX = +(Math.sin(t * 1.1) * 0.85 + (Math.random() - 0.5) * 0.03).toFixed(2);
      const simY = +(Math.cos(t * 0.85) * 0.75 + (Math.random() - 0.5) * 0.03).toFixed(2);
      const simZ = +(Math.sqrt(Math.max(0.05, 1 - simX * simX * 0.4 - simY * simY * 0.4))).toFixed(2);

      const fakeJson = JSON.stringify({ x: simX, y: simY, z: simZ });
      appendTerminalLog(fakeJson);
      processSample(simX, simY, simZ, 'SIM');
    }, 100);
  }

  async function stopAllModes() {
    if (state.simInterval) {
      clearInterval(state.simInterval);
      state.simInterval = null;
    }
    if (state.subscribedTopic && state.mqttClient) {
      try {
        state.mqttClient.unsubscribe(state.subscribedTopic);
      } catch (_) {}
      state.subscribedTopic = null;
    }
    if (state.port) {
      await disconnectWebSerial();
    }
    setConnectionState('disconnected', 'Desconectado');
  }

  function setConnectionState(mode, statusMessage) {
    state.mode = mode;
    el.statusText.textContent = statusMessage;

    if (mode === 'serial') {
      el.statusPill.dataset.state = 'connected';
      el.btnConnectSerial.innerHTML = '<span>Desconectar STM32 (USB)</span>';
      el.btnConnectSerial.classList.replace('btn-primary', 'btn-danger');
      el.btnWatchRemote.textContent = 'Assistir Sala Remota';
      el.btnSimulate.textContent = 'Modo Simulador';
    } else if (mode === 'remote') {
      el.statusPill.dataset.state = 'remote';
      el.btnConnectSerial.innerHTML = '<span>Conectar STM32 (USB)</span>';
      el.btnConnectSerial.classList.replace('btn-danger', 'btn-primary');
      el.btnWatchRemote.textContent = 'Parar de Assistir Sala';
      el.btnSimulate.textContent = 'Modo Simulador';
    } else if (mode === 'simulated') {
      el.statusPill.dataset.state = 'simulated';
      el.btnConnectSerial.innerHTML = '<span>Conectar STM32 (USB)</span>';
      el.btnConnectSerial.classList.replace('btn-danger', 'btn-primary');
      el.btnWatchRemote.textContent = 'Assistir Sala Remota';
      el.btnSimulate.textContent = 'Parar Simulador';
    } else {
      el.statusPill.dataset.state = 'disconnected';
      el.btnConnectSerial.innerHTML = '<span>Conectar STM32 (USB)</span>';
      el.btnConnectSerial.classList.replace('btn-danger', 'btn-primary');
      el.btnWatchRemote.textContent = 'Assistir Sala Remota';
      el.btnSimulate.textContent = 'Modo Simulador';
    }
  }

  // =========================================================================
  // 6. GRÁFICO OSCILOSCÓPIO EM CANVAS (60 FPS)
  // =========================================================================
  function renderChart() {
    const width = el.canvas.width;
    const height = el.canvas.height;
    const midY = height / 2;
    const maxG = state.chartScaleG;

    ctx.clearRect(0, 0, width, height);

    // Grade horizontal
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
    ctx.lineWidth = 1;
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillStyle = '#64748b';

    const steps = [-maxG, -maxG / 2, 0, maxG / 2, maxG];
    for (const gVal of steps) {
      const yPos = midY - (gVal / maxG) * (height * 0.42);
      ctx.beginPath();
      ctx.moveTo(0, yPos);
      ctx.lineTo(width, yPos);
      ctx.stroke();
      ctx.fillText(`${gVal > 0 ? '+' : ''}${gVal.toFixed(1)}g`, 8, yPos - 4);
    }

    if (state.history.length < 2) {
      requestAnimationFrame(renderChart);
      return;
    }

    const drawAxisCurve = (key, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      const len = state.history.length;
      for (let i = 0; i < len; i++) {
        const pt = state.history[i];
        const xPx = (i / (MAX_HISTORY_POINTS - 1)) * width;
        const clampedVal = Math.max(-maxG, Math.min(maxG, pt[key]));
        const yPx = midY - (clampedVal / maxG) * (height * 0.42);
        if (i === 0) ctx.moveTo(xPx, yPx);
        else ctx.lineTo(xPx, yPx);
      }
      ctx.stroke();
    };

    drawAxisCurve('x', '#38bdf8');
    drawAxisCurve('y', '#34d399');
    drawAxisCurve('z', '#fbbf24');

    requestAnimationFrame(renderChart);
  }

  // =========================================================================
  // 7. EVENTOS DE INTERFACE E UTILITÁRIOS
  // =========================================================================
  function setupEventListeners() {
    el.btnConnectSerial.addEventListener('click', connectWebSerial);
    el.btnSimulate.addEventListener('click', toggleSimulator);
    el.btnWatchRemote.addEventListener('click', toggleWatchRemoteRoom);

    el.btnCopyShareLink.addEventListener('click', async () => {
      const room = (el.roomInput.value || 'senai-stm32-f103rb').trim();
      const shareUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(room)}`;
      try {
        await navigator.clipboard.writeText(shareUrl);
        const origText = el.btnCopyShareLink.textContent;
        el.btnCopyShareLink.textContent = 'Link Copiado!';
        setTimeout(() => {
          el.btnCopyShareLink.textContent = origText;
        }, 2000);
      } catch (_) {
        prompt('Copie o link abaixo para acessar em tempo real de qualquer lugar:', shareUrl);
      }
    });

    el.btnToggleLcdColor.addEventListener('click', () => {
      const nextTheme = el.lcdScreen.dataset.theme === 'blue' ? 'green' : 'blue';
      el.lcdScreen.dataset.theme = nextTheme;
    });

    el.btnTare.addEventListener('click', () => {
      state.tare = {
        x: state.raw.x,
        y: state.raw.y,
        z: state.raw.z,
        active: true
      };
      el.tareStatusText.textContent = `Tara ativa: Offset (${state.tare.x.toFixed(2)}g, ${state.tare.y.toFixed(2)}g, ${state.tare.z.toFixed(2)}g)`;
    });

    el.btnResetTare.addEventListener('click', () => {
      state.tare = { x: 0, y: 0, z: 0, active: false };
      el.tareStatusText.textContent = 'Sem offset aplicado (Leitura bruta do STM32)';
    });

    el.chartScaleSelect.addEventListener('change', () => {
      state.chartScaleG = parseFloat(el.chartScaleSelect.value) || 4;
    });

    el.btnPauseChart.addEventListener('click', () => {
      state.chartPaused = !state.chartPaused;
      el.btnPauseChart.textContent = state.chartPaused ? 'Retomar Gráfico' : 'Pausar Gráfico';
    });

    el.btnClearChart.addEventListener('click', () => {
      state.history.length = 0;
    });

    el.btnClearLog.addEventListener('click', () => {
      logLines.length = 0;
      el.serialTerminal.textContent = '';
    });

    el.btnExportCsv.addEventListener('click', () => {
      if (state.recordedRows.length === 0) {
        alert('Nenhuma amostra registrada ainda para exportar.');
        return;
      }
      const header = 'timestamp_iso,x_g,y_g,z_g,magnitude_g,pitch_deg,roll_deg\n';
      const body = state.recordedRows
        .map((r) => `${r.timestamp},${r.x},${r.y},${r.z},${r.mag},${r.pitch},${r.roll}`)
        .join('\n');
      const blob = new Blob([header + body], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `telemetria_stm32_adxl345_${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });

    // Cálculo periódico da taxa de amostragem (Hz)
    setInterval(() => {
      const now = performance.now();
      const elapsedSec = (now - state.lastRateCalcTime) / 1000;
      if (elapsedSec > 0) {
        state.sampleRateHz = state.samplesInWindow / elapsedSec;
        el.sampleRate.textContent = `${state.sampleRateHz.toFixed(1)} Hz`;
        state.samplesInWindow = 0;
        state.lastRateCalcTime = now;
      }
    }, 1000);
  }

  function init() {
    if (!('serial' in navigator)) {
      el.webSerialWarning.classList.remove('hidden');
    }

    setupEventListeners();
    requestAnimationFrame(renderChart);

    // Se a URL já vier com ?room=NOME_DA_SALA, entra automaticamente no modo Espectador Remoto!
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
      el.roomInput.value = roomParam;
      setTimeout(() => {
        toggleWatchRemoteRoom();
      }, 400);
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
