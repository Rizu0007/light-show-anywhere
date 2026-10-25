//! Decoding channel bytes into Tesla commands.
//!
//! xLights stores an effect's brightness percentage as a byte. Tesla assigns meaning to specific
//! percentages:
//!
//! | Brightness | Byte | Light command        | Closure command |
//! |------------|------|----------------------|-----------------|
//! | 0 %        | 0    | Off, instant         | Idle            |
//! | 10 %       | 25   | Off over 500 ms      |                 |
//! | 20 %       | 51   | Off over 1000 ms     |                 |
//! | 25 %       | 63   |                      | Open            |
//! | 30 %       | 76   | Off over 2000 ms     |                 |
//! | 50 %       | 127  |                      | Dance           |
//! | 70 %       | 178  | On over 500 ms       |                 |
//! | 75 %       | 191  |                      | Close           |
//! | 80 %       | 204  | On over 1000 ms      |                 |
//! | 90 %       | 229  | On over 2000 ms      |                 |
//! | 100 %      | 255  | On, instant          | Stop            |
//!
//! Bytes in between are rounded to the nearest documented value. The light bands keep Tesla's
//! rule that anything above 50 % means "on".

/// A light command: target state plus how long the ramp takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct LightCommand {
    /// Turn on (`true`) or off (`false`).
    pub on: bool,
    /// Ramp duration in milliseconds; 0 means instant.
    pub ramp_ms: u16,
}

impl LightCommand {
    /// Decodes a channel byte.
    #[must_use]
    pub const fn from_byte(value: u8) -> Self {
        let (on, ramp_ms) = match value {
            0..=12 => (false, 0),
            13..=38 => (false, 500),
            39..=63 => (false, 1000),
            64..=127 => (false, 2000),
            128..=191 => (true, 500),
            192..=216 => (true, 1000),
            217..=242 => (true, 2000),
            243..=255 => (true, 0),
        };
        Self { on, ramp_ms }
    }

    /// The byte xLights writes for this command.
    #[must_use]
    pub const fn to_byte(self) -> u8 {
        match (self.on, self.ramp_ms) {
            (false, 0) => 0,
            (false, 1..=750) => 25,
            (false, 751..=1500) => 51,
            (false, _) => 76,
            (true, 0) => 255,
            (true, 1..=750) => 178,
            (true, 751..=1500) => 204,
            (true, _) => 229,
        }
    }
}

/// A closure command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ClosureCommand {
    /// Stop, unless an open or close is in progress, which finishes first.
    Idle,
    /// Open fully, then stop.
    Open,
    /// Oscillate between two positions (only when already open, except windows).
    Dance,
    /// Close fully, then stop.
    Close,
    /// Stop immediately.
    Stop,
}

impl ClosureCommand {
    /// Decodes a channel byte.
    #[must_use]
    pub const fn from_byte(value: u8) -> Self {
        match value {
            0..=31 => Self::Idle,
            32..=95 => Self::Open,
            96..=159 => Self::Dance,
            160..=223 => Self::Close,
            224..=255 => Self::Stop,
        }
    }

    /// The byte xLights writes for this command.
    #[must_use]
    pub const fn to_byte(self) -> u8 {
        match self {
            Self::Idle => 0,
            Self::Open => 63,
            Self::Dance => 127,
            Self::Close => 191,
            Self::Stop => 255,
        }
    }

    /// Whether the command counts towards the per-show actuation limit.
    #[must_use]
    pub const fn counts_towards_limit(self) -> bool {
        matches!(self, Self::Open | Self::Dance | Self::Close)
    }
}
