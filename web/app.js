/**
 * Telemetria STM32F103RB + Acelerômetro ADXL345 + LCD 16x2 I2C
 * Desenvolvido por Gabriel Piske (https://piske.online)
 *
 * Suporta:
 *  1. Conexão Direta via Cabo USB (Web Serial API - USART2 @ 115200 bps)
 *  2. Modo Simulador Integrado para testes sem a placa física
 */

(() => {
  'use strict';

  const G_TO_MS2 = 9.80665;
  const MAX_HISTORY_POINTS = 220;
  const MAX_LOG_LINES = 180;

  // Estado da Aplicação
  const state = {
    mode: 'disconnected', // 'disconnected' | 'serial' | 'simulated'
    port: null,
    reader: null,
    keepReading: false,
    simInterval: null,

    // Última leitura bruta e calibrada (em g)
    raw: { x: 0, y: 0, z: 0 },
    tare: { x: 0, y: 0, z: 0, active: false },
    current: { x: 0, y: 0, z: 0, pitch: 0, roll: 0 },

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

    valXg: document.getElementById('valXg'),
    valYg: document.getElementById('valYg'),
    valZg: document.getElementById('valZg'),
    valXms2: document.getElementById('valXms2'),
    valYms2: document.getElementById('valYms2'),
    valZms2: document.getElementById('valZms2'),
    barX: document.getElementById('barX'),
    barY: document.getElementById('barY'),
    barZ: document.getElementById('barZ'),

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
  function processSample(rawX, rawY, rawZ) {
    state.raw.x = rawX;
    state.raw.y = rawY;
    state.raw.z = rawZ;

    const x = state.tare.active ? rawX - state.tare.x : rawX;
    const y = state.tare.active ? rawY - state.tare.y : rawY;
    const z = state.tare.active ? rawZ - state.tare.z : rawZ;

    // Ângulos de inclinação para animar a Orientação Espacial 3D
    const roll = Math.atan2(y, z) * (180 / Math.PI);
    const pitch = Math.atan2(-x, Math.sqrt(y * y + z * z)) * (180 / Math.PI);

    state.current = { x, y, z, pitch, roll };
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
        z: z.toFixed(3)
      });
    }

    updateDashboardUI();
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
    const { x, y, z, pitch, roll } = state.current;

    el.valXg.textContent = x.toFixed(2);
    el.valYg.textContent = y.toFixed(2);
    el.valZg.textContent = z.toFixed(2);

    el.valXms2.textContent = `${(x * G_TO_MS2).toFixed(2)} m/s²`;
    el.valYms2.textContent = `${(y * G_TO_MS2).toFixed(2)} m/s²`;
    el.valZms2.textContent = `${(z * G_TO_MS2).toFixed(2)} m/s²`;

    updateGaugeBar(el.barX, x, state.chartScaleG);
    updateGaugeBar(el.barY, y, state.chartScaleG);
    updateGaugeBar(el.barZ, z, state.chartScaleG);

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
      alert('Seu navegador não suporta a Web Serial API. Utilize Google Chrome ou Microsoft Edge no computador, ou clique em "Modo Simulador".');
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
                processSample(parsed.x, parsed.y, parsed.z);
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
  // 4. MODO SIMULADOR (PARA TESTES SEM HARDWARE FÍSICO)
  // =========================================================================
  async function toggleSimulator() {
    if (state.mode === 'simulated') {
      await stopAllModes();
      return;
    }

    await stopAllModes();
    setConnectionState('simulated', 'Modo Simulador Ativo (10 Hz)');
    appendTerminalLog('Modo Simulador iniciado. Gerando pacotes JSON idênticos ao STM32F103RB...');

    let t = 0;
    state.simInterval = setInterval(() => {
      t += 0.1;
      const simX = +(Math.sin(t * 1.1) * 0.85 + (Math.random() - 0.5) * 0.03).toFixed(2);
      const simY = +(Math.cos(t * 0.85) * 0.75 + (Math.random() - 0.5) * 0.03).toFixed(2);
      const simZ = +(Math.sqrt(Math.max(0.05, 1 - simX * simX * 0.4 - simY * simY * 0.4))).toFixed(2);

      const fakeJson = JSON.stringify({ x: simX, y: simY, z: simZ });
      appendTerminalLog(fakeJson);
      processSample(simX, simY, simZ);
    }, 100);
  }

  async function stopAllModes() {
    if (state.simInterval) {
      clearInterval(state.simInterval);
      state.simInterval = null;
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
      el.btnSimulate.textContent = 'Modo Simulador';
    } else if (mode === 'simulated') {
      el.statusPill.dataset.state = 'simulated';
      el.btnConnectSerial.innerHTML = '<span>Conectar STM32 (USB)</span>';
      el.btnConnectSerial.classList.replace('btn-danger', 'btn-primary');
      el.btnSimulate.textContent = 'Parar Simulador';
    } else {
      el.statusPill.dataset.state = 'disconnected';
      el.btnConnectSerial.innerHTML = '<span>Conectar STM32 (USB)</span>';
      el.btnConnectSerial.classList.replace('btn-danger', 'btn-primary');
      el.btnSimulate.textContent = 'Modo Simulador';
    }
  }

  // =========================================================================
  // 5. GRÁFICO OSCILOSCÓPIO EM CANVAS (60 FPS)
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
  // 6. EVENTOS DE INTERFACE E UTILITÁRIOS
  // =========================================================================
  function setupEventListeners() {
    el.btnConnectSerial.addEventListener('click', connectWebSerial);
    el.btnSimulate.addEventListener('click', toggleSimulator);

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
      const header = 'timestamp_iso,x_g,y_g,z_g\n';
      const body = state.recordedRows
        .map((r) => `${r.timestamp},${r.x},${r.y},${r.z}`)
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
  }

  window.addEventListener('DOMContentLoaded', init);
})();
