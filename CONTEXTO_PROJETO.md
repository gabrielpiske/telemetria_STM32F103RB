# Contexto Técnico do Projeto — Telemetria STM32F103RB + Acelerômetro ADXL345 + LCD I2C + Web App

Este documento consolida o contexto completo de hardware, firmware, protocolo serial e arquitetura web do projeto para uso por desenvolvedores e agentes de IA.

---

## 1. Visão Geral do Sistema

O projeto realiza a leitura triaxial ($X, Y, Z$) de um acelerômetro **ADXL345** conectado via barramento **I2C1** a um microcontrolador **STM32F103RBT6 (Placa Nucleo-F103RB)**. Os valores convertidos em unidades de gravidade ($g$) são:
1. Exibidos localmente em um **Display LCD 16x2 (HD44780 com módulo I2C PCF8574)**;
2. Transmitidos em tempo real via **Monitor Serial USB (ST-LINK Virtual COM Port / `USART2`)** no formato JSON (`{"x":0.00,"y":0.00,"z":1.00}\r\n`);
3. Consumidos por uma **Aplicação Web (HTML5 + CSS3 + JavaScript Vanilla)** hospedada na **Vercel**, que permite tanto:
   - **Conexão Local Direta (Web Serial API):** Leitura direta da porta `COM` via navegador (Chrome, Edge, Opera) em qualquer computador onde o STM32 esteja conectado via USB.
   - **Monitoramento Remoto em Tempo Real (Broadcast WebSockets / MQTT):** O computador conectado ao STM32 atua como **Host Transmissor** e retransmite os dados em tempo real para um canal seguro (`WSS`), permitindo que **qualquer pessoa em qualquer lugar do mundo** (inclusive pelo celular ou outro PC remoto) acompanhe os dados ao vivo acessando o link da Vercel.

---

## 2. Especificações de Hardware e Pinos (STM32 Nucleo-F103RB)

| Componente / Periférico | Interface / Barramento | Pinos no STM32F103RB | Parâmetros de Hardware |
| :--- | :--- | :--- | :--- |
| **MCU** | ARM Cortex-M3 | `STM32F103RBT6` (LQFP64) | Clock `SYSCLK` = 64 MHz (`HSI` 8 MHz + `PLL` x16), `APB1` = 32 MHz, `APB2` = 64 MHz |
| **Acelerômetro ADXL345** | `I2C1` (Fast Mode 400 kHz) | `PB8` (`I2C1_SCL`), `PB9` (`I2C1_SDA`) | Endereço I2C 8-bit: `0xA6` (`0x53` em 7-bit), Chip ID (`0x00`) = `0xE5`, Escala: $\pm 4g$ (10-bit), Fator: `0.0078 g/LSB` |
| **Display LCD 16x2 I2C** | `I2C1` (Compartilhado) | `PB8` (`I2C1_SCL`), `PB9` (`I2C1_SDA`) | Controlador HD44780 (`liquidcrystal_i2c.c`), 2 linhas x 16 colunas |
| **Comunicação Serial USB** | `USART2` (ST-LINK VCP) | `PA2` (`USART2_TX`), `PA3` (`USART2_RX`) | Baud Rate: `115200 bps`, `8N1` (8 bits de dados, sem paridade, 1 stop bit, sem controle de fluxo) |
| **LED de Usuário (LD2)** | `GPIO_Output` | `PA5` | LED Verde onboard da Nucleo-F103RB |
| **Botão de Usuário (B1)** | `GPIO_EXTI13` | `PC13` | Push-button Azul onboard (Borda de descida) |

---

## 3. Funcionamento do Firmware (`Core/Src/main.c`)

### 3.1. Leitura e Conversão do ADXL345
- **Inicialização (`ADXL_Init`)**:
  - Lê o registrador `0x00` (`DEVID`) e valida se o valor é `0xE5`.
  - Escreve `0x00` e depois `0x08` no registrador `0x2D` (`POWER_CTL`) para ativar o modo de medição (`Measure = 1`).
  - Escreve `0x01` no registrador `0x31` (`DATA_FORMAT`) configurando escala de $\pm 4g$.
- **Amostragem no Loop Principal (`while(1)`)**:
  - Lê 6 bytes consecutivos a partir do registrador `0x32` (`DATAX0` até `DATAZ1`):
    - `RAWX = (int16_t)((RxData[1] << 8) | RxData[0])`
    - `RAWY = (int16_t)((RxData[3] << 8) | RxData[2])`
    - `RAWZ = (int16_t)((RxData[5] << 8) | RxData[4])`
  - Converte para gravidade ($g$):
    - `xg = RAWX * 0.0078f`
    - `yg = RAWY * 0.0078f`
    - `zg = RAWZ * 0.0078f`
  - Taxa de atualização: `HAL_Delay(100)` (~10 amostras por segundo / 10 Hz).

### 3.2. Transmissão Serial (`USART2`)
- A função `UART2_Init(115200)` habilita o clock da `USART2` no barramento `APB1` (32 MHz), configura `PA2` como `AF_PP` e `PA3` como `INPUT_PULLUP`, e calcula o registrador `USART2->BRR` automaticamente a partir de `HAL_RCC_GetPCLK1Freq()`.
- A cada ciclo do `while(1)`, o STM32 envia uma linha JSON terminada por `\r\n`:
  ```json
  {"x":0.04,"y":-0.02,"z":0.98}
  ```
- A flag `-u _printf_float` já está habilitada no linker (`Debug/makefile`), permitindo formatação `%.2f` no `snprintf`.

---

## 4. Protocolo de Comunicação Serial (STM32 $\rightarrow$ Web App)

- **Porta:** STMicroelectronics STLink Virtual COM Port (`COMx` no Windows, `/dev/ttyACM0` no Linux/macOS)
- **Baud Rate Padrão:** `115200` (suporte configurável na interface para `9600`, `19200`, `38400`, `57600`, `115200`)
- **Formato de Quadro:** `8N1` (8 Data Bits, Parity None, 1 Stop Bit)
- **Delimitador de Pacote:** Quebra de linha (`\n` ou `\r\n`)
- **Formatos Aceitos pelo Parser da Aplicação Web:**
  1. **JSON (Padrão recomendado):** `{"x":0.12,"y":-0.05,"z":0.98}`
  2. **CSV Puro:** `0.12,-0.05,0.98` ou `0.12;-0.05;0.98`
  3. **Texto Chave-Valor:** `x- 0.12 y- -0.05 z- 0.98` ou `X:0.12 Y:-0.05 Z:0.98`

---

## 5. Arquitetura da Aplicação Web (Hospedagem na Vercel + Tempo Real Global)

Para atender ao requisito de **hospedar na Vercel** e **permitir acesso em tempo real de qualquer lugar**, a aplicação web na pasta `web/` opera em 3 modos integrados sem exigir manutenção de servidor backend próprio:

```
┌──────────────────┐   Cabo USB (USART2)    ┌─────────────────────────────────────────┐
│  STM32F103RB     │ ─────────────────────► │ Navegador no PC da Bancada (Vercel URL) │
│  + ADXL345 + LCD │   115200 bps (JSON)    │ [Modo 1: Web Serial API + Host Live]    │
└──────────────────┘                        └───────────────────┬─────────────────────┘
                                                                │ Publica em Tempo Real
                                                                │ (MQTT over WSS / TLS)
                                                                ▼
                                            ┌─────────────────────────────────────────┐
                                            │ Broker WebSocket Público (HiveMQ WSS)   │
                                            │ Tópico: senai/stm32/telemetria/<SALA>   │
                                            └───────────────────┬─────────────────────┘
                                                                │ Assina em Tempo Real
                                                                ▼
                                            ┌─────────────────────────────────────────┐
                                            │ Qualquer Pessoa em Qualquer Lugar       │
                                            │ (Celular, Tablet, outro PC na Vercel)   │
                                            │ [Modo 2: Espectador Remoto Live]        │
                                            └─────────────────────────────────────────┘
```

### Requisitos do Navegador
- **Para conectar o cabo USB direto (Modo 1 - Web Serial API):** Google Chrome (v89+), Microsoft Edge (v89+) ou Opera em Desktop (Windows, Linux, macOS ou Chromebook) sob HTTPS (`vercel.app` ou `localhost`).
- **Para assistir remotamente de qualquer lugar (Modo 2 - Espectador Live):** Qualquer navegador moderno em **qualquer dispositivo** (Android, iPhone/iOS, Windows, Mac, Smart TV), bastando abrir o link da sala (`https://seu-app.vercel.app/?room=CODIGO`).
