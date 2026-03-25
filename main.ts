// ============================================================
// Grove Sunlight Sensor – MakeCode PXT Extension
// Unterstützt: SI1145 (V1) und SI1151 (V2)
//
// ============================================================

// Sensor-Versionsauswahl – erscheint als Dropdown im Init-Block
enum SensorVersion {
    //% block="SI1151 (V2)"
    SI1151 = 0,
    //% block="SI1145 (V1)"
    SI1145 = 1
}

//% color=#F7B731 icon="\uf185" block="Sonnenlichtsensor"
namespace SunlightSensor {

    // Welcher Sensor wurde initialisiert?
    let _activeSensor: SensorVersion = SensorVersion.SI1151;


    // ============================================================
    // SI1145 – Interne Implementierung
    // I2C-Adresse: 0x60
    // Betrieb: Auto-Modus (kontinuierliche Messung)
    // UV-Index: direkte Hardware-Messung via eingebautem UV-Detektor
    // ============================================================

    const SI45_ADDR = 0x60;

    function si45_setreg(reg: number, dat: number): void {
        let buf = pins.createBuffer(2);
        buf[0] = reg;
        buf[1] = dat;
        pins.i2cWriteBuffer(SI45_ADDR, buf);
    }

    function si45_getreg(reg: number): number {
        pins.i2cWriteNumber(SI45_ADDR, reg, NumberFormat.UInt8BE);
        return pins.i2cReadNumber(SI45_ADDR, NumberFormat.UInt8BE);
    }

    function si45_getUInt16LE(reg: number): number {
        pins.i2cWriteNumber(SI45_ADDR, reg, NumberFormat.UInt8BE);
        return pins.i2cReadNumber(SI45_ADDR, NumberFormat.UInt16LE);
    }

    function si45_writeParam(p: number, v: number): number {
        si45_setreg(0x17, v);
        si45_setreg(0x18, p | 0xA0);
        return si45_getreg(0x2E);
    }

    function si45_init(): void {
        // Reset-Sequenz
        si45_setreg(0x08, 0x00);
        si45_setreg(0x09, 0x00);
        si45_setreg(0x04, 0x00);
        si45_setreg(0x05, 0x00);
        si45_setreg(0x06, 0x00);
        si45_setreg(0x03, 0x00);
        si45_setreg(0x21, 0xFF);
        si45_setreg(0x18, 0x01);
        basic.pause(10);
        si45_setreg(0x07, 0x17);
        basic.pause(10);
        // UV-Index-Koeffizienten laut Datenblatt
        si45_setreg(0x13, 0x29);
        si45_setreg(0x14, 0x89);
        si45_setreg(0x15, 0x02);
        si45_setreg(0x16, 0x00);
        // UV + Sichtbar + IR aktivieren
        si45_writeParam(0x01, 0x80 | 0x20 | 0x10);
        // Interrupt bei jeder Messung
        si45_setreg(0x03, 0x01);
        si45_setreg(0x04, 0x01);
        // Messrate (Auto): 255 × 31,25 µs ≈ 8 ms
        si45_setreg(0x08, 0xFF);
        // Auto-Modus starten
        si45_setreg(0x18, 0x0F);
    }


    // ============================================================
    // SI1151 – Interne Implementierung
    // I2C-Adresse: 0x53
    // Betrieb: FORCE-Modus (Messung auf Anforderung)
    // UV-Index: berechnet aus IR- und Visible-Kanal (kein UV-Detektor)
    // ============================================================

    const SI51_ADDR = 0x53;

    // Parameter-Register-Adressen (SI1151)
    const SI51_CHAN_LIST    = 0x01;
    const SI51_ADCCONFIG_0  = 0x02;
    const SI51_ADCSENS_0    = 0x03;
    const SI51_ADCPOST_0    = 0x04;
    const SI51_MEASCONFIG_0 = 0x05;
    const SI51_MEASRATE_H   = 0x1A;
    const SI51_MEASRATE_L   = 0x1B;
    const SI51_MEASCOUNT_0  = 0x1C;
    const SI51_MEASCOUNT_1  = 0x1D;
    const SI51_MEASCOUNT_2  = 0x1E;

    // Steuer-Register-Adressen (SI1151)
    const SI51_HOSTIN_0  = 0x0A;
    const SI51_COMMAND   = 0x0B;
    const SI51_RESPONSE_0 = 0x11;
    const SI51_RESPONSE_1 = 0x10;
    const SI51_HOSTOUT_0 = 0x13;
    const SI51_HOSTOUT_2 = 0x15;

    // Befehls-Codes (SI1151)
    const SI51_RESET_SW  = 0x01;
    const SI51_FORCE     = 0x11;

    let si51_writeBuf: Buffer = pins.createBuffer(2);

    function si51_write(): void {
        pins.i2cWriteBuffer(SI51_ADDR, si51_writeBuf, false);
    }

    function si51_readReg(reg: number): number {
        let buf = pins.createBuffer(1);
        buf[0] = reg;
        pins.i2cWriteBuffer(SI51_ADDR, buf, false);
        buf = pins.i2cReadBuffer(SI51_ADDR, 1, false);
        return buf[0];
    }

    function si51_readReg16(reg: number): number {
        let buf = pins.createBuffer(1);
        buf[0] = reg;
        pins.i2cWriteBuffer(SI51_ADDR, buf, false);
        buf = pins.i2cReadBuffer(SI51_ADDR, 2, false);
        return buf[0] * 256 + buf[1];  // Big-Endian laut Datenblatt
    }

    // Befehl senden und auf Bestätigung durch Befehlszähler warten
    function si51_sendCommand(code: number): void {
        let r: number;
        let ctr: number;
        do {
            ctr = si51_readReg(SI51_RESPONSE_0);
            si51_writeBuf[0] = SI51_COMMAND;
            si51_writeBuf[1] = code;
            si51_write();
            r = si51_readReg(SI51_RESPONSE_0);
        } while (r == ctr);  // warten bis Zähler sich ändert
    }

    // Parameter im RAM des SI1151 setzen
    function si51_paramSet(loc: number, val: number): void {
        let r: number;
        let ctr: number;
        do {
            ctr = si51_readReg(SI51_RESPONSE_0);
            si51_writeBuf[0] = SI51_HOSTIN_0;
            si51_writeBuf[1] = val;
            si51_write();
            si51_writeBuf[0] = SI51_COMMAND;
            si51_writeBuf[1] = loc | 0x80;  // PARAM_SET
            si51_write();
            r = si51_readReg(SI51_RESPONSE_0);
        } while (r == ctr);  // warten bis Zähler sich ändert
    }

    // Kanal konfigurieren (4 Register: ADCCONFIG, ADCSENS, ADCPOST, MEASCONFIG)
    function si51_configChannel(index: number, adcConfig: number, adcSens: number, adcPost: number, measConfig: number): void {
        if (index < 0 || index > 5) return;
        const inc = index * 4;
        si51_paramSet(SI51_ADCCONFIG_0 + inc, adcConfig);
        si51_paramSet(SI51_ADCSENS_0 + inc, adcSens);
        si51_paramSet(SI51_ADCPOST_0 + inc, adcPost);
        si51_paramSet(SI51_MEASCONFIG_0 + inc, measConfig);
    }

    function si51_init(): void {
        si51_sendCommand(SI51_RESET_SW);
        basic.pause(25);
        // Kanal 0: Large IR  (ADCMUX = 0x0D)
        si51_configChannel(0, 0x0D, 0x00, 0x00, 0x00);
        // Kanal 1: Large White / sichtbares Licht  (ADCMUX = 0x0F)
        si51_configChannel(1, 0x0F, 0x00, 0x00, 0x00);
        // Kanal 2: Small IR  (ADCMUX = 0x00)
        si51_configChannel(2, 0x00, 0x00, 0x00, 0x00);
        si51_paramSet(SI51_MEASRATE_H, 0);
        si51_paramSet(SI51_MEASRATE_L, 1);
        si51_paramSet(SI51_MEASCOUNT_0, 5);
        si51_paramSet(SI51_MEASCOUNT_1, 10);
        si51_paramSet(SI51_MEASCOUNT_2, 10);
        basic.pause(100);
    }

    function si51_readVisible(): number {
        // Nur Kanal 1 (Large White) → Ergebnis in HOSTOUT_0/1
        si51_paramSet(SI51_CHAN_LIST, 0x02);
        si51_sendCommand(SI51_FORCE);
        basic.pause(10);
        return si51_readReg16(SI51_HOSTOUT_0);
    }

    function si51_readIR(): number {
        // Nur Kanal 0 (Large IR) → Ergebnis in HOSTOUT_0/1
        si51_paramSet(SI51_CHAN_LIST, 0x01);
        si51_sendCommand(SI51_FORCE);
        basic.pause(10);
        return si51_readReg16(SI51_HOSTOUT_0);
    }

    function si51_readUV(): number {
        // Kanal 0 (IR) + Kanal 1 (Visible) gleichzeitig
        // Kanal 0 → HOSTOUT_0/1, Kanal 1 → HOSTOUT_2/3
        si51_paramSet(SI51_CHAN_LIST, 0x03);
        si51_sendCommand(SI51_FORCE);
        basic.pause(10);
        let ch_ir  = si51_readReg16(SI51_HOSTOUT_0);
        let ch_vis = si51_readReg16(SI51_HOSTOUT_2);
        // UV-Annäherung aus IR und Visible (AN498-Formelstruktur)
        // Koeffizienten ggf. mit kalibriertem UV-Meter anpassen
        let uv = (ch_vis * 5.41 - ch_ir * 0.08) / 1000.0;
        if (uv < 0) uv = 0;
        return uv;
    }


    // ============================================================
    // Öffentliche API – gleiche Blöcke für beide Sensoren
    // ============================================================

    /**
     * Initialise the Grove Sunlight Sensor.
     * Select the sensor version from the dropdown.
     */
    //% group="Sonnenlichtsensor"
    //% block="Sonnenlichtsensor %version an A0 initialisieren"
    //% version.fieldEditor="gridpicker"
    //% weight=100
    export function initSunlight(version: SensorVersion): void {
        _activeSensor = version;
        if (version === SensorVersion.SI1145) {
            si45_init();
        } else {
            si51_init();
        }
    }

    /**
     * Returns the current visible light reading.
     */
    //% group="Sonnenlichtsensor"
    //% block="Lichtstärke"
    //% weight=80
    export function getHalfWord_Visible(): number {
        if (_activeSensor === SensorVersion.SI1145) {
            return si45_getUInt16LE(0x22);
        } else {
            return Math.round(si51_readVisible());
        }
    }

    /**
     * Returns the current infrared reading.
     */
    //% group="Sonnenlichtsensor"
    //% block="Infrarot"
    //% weight=70
    export function getHalfWordIR(): number {
        if (_activeSensor === SensorVersion.SI1145) {
            return si45_getUInt16LE(0x24);
        } else {
            return Math.round(si51_readIR());
        }
    }

    /**
     * Returns the UV index. Directly measured on SI1145,
     * calculated from IR and visible channels on SI1151.
     */
    //% group="Sonnenlichtsensor"
    //% block="UV-Index"
    //% weight=60
    export function getHalfWordUV(): number {
        if (_activeSensor === SensorVersion.SI1145) {
            return si45_getUInt16LE(0x2C) / 100;
        } else {
            return Math.round(si51_readUV() * 10) / 10;
        }
    }
}