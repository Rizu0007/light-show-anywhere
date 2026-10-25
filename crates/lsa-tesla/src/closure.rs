//! Closure facts and per-show command limits (Tesla README, "Closures channels").

use lsa_fseq::Sequence;

use crate::channel::{Channel, Closure};
use crate::command::ClosureCommand;

impl Closure {
    /// Every closure channel, in channel order.
    pub const ALL: [Self; 16] = {
        use crate::channel::Side::{Left as L, Right as R};
        [
            Self::FalconDoor(L),
            Self::FalconDoor(R),
            Self::FrontDoor(L),
            Self::FrontDoor(R),
            Self::Mirror(L),
            Self::Mirror(R),
            Self::Window {
                side: L,
                rear: false,
            },
            Self::Window {
                side: L,
                rear: true,
            },
            Self::Window {
                side: R,
                rear: false,
            },
            Self::Window {
                side: R,
                rear: true,
            },
            Self::Liftgate,
            Self::DoorHandle {
                side: L,
                rear: false,
            },
            Self::DoorHandle {
                side: L,
                rear: true,
            },
            Self::DoorHandle {
                side: R,
                rear: false,
            },
            Self::DoorHandle {
                side: R,
                rear: true,
            },
            Self::ChargePort,
        ]
    };

    /// Maximum Open, Close and Dance commands per show.
    #[must_use]
    pub const fn command_limit(self) -> u32 {
        match self {
            Self::Liftgate | Self::Window { .. } | Self::FrontDoor(_) | Self::FalconDoor(_) => 6,
            Self::Mirror(_) | Self::DoorHandle { .. } => 20,
            Self::ChargePort => 3,
        }
    }

    /// Whether the closure honours Dance.
    #[must_use]
    pub const fn supports_dance(self) -> bool {
        matches!(
            self,
            Self::Liftgate | Self::ChargePort | Self::Window { .. } | Self::FalconDoor(_)
        )
    }

    /// Whether Dance works from any position (only windows) rather than only when fully open.
    #[must_use]
    pub const fn dances_when_closed(self) -> bool {
        matches!(self, Self::Window { .. })
    }

    /// Approximate time to open fully, in milliseconds.
    #[must_use]
    pub const fn open_ms(self) -> u32 {
        match self {
            Self::Liftgate => 14_000,
            Self::FrontDoor(_) => 22_000,
            Self::FalconDoor(_) => 20_000,
            Self::Window { .. } => 4_000,
            Self::Mirror(_) | Self::DoorHandle { .. } | Self::ChargePort => 2_000,
        }
    }

    /// Approximate time to close fully, in milliseconds.
    #[must_use]
    pub const fn close_ms(self) -> u32 {
        match self {
            Self::Liftgate | Self::Window { .. } => 4_000,
            Self::FrontDoor(_) => 3_000,
            Self::FalconDoor(_) => 8_000,
            Self::Mirror(_) | Self::DoorHandle { .. } | Self::ChargePort => 2_000,
        }
    }
}

/// How many limited commands a show sends to one closure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ClosureUsage {
    /// The closure.
    pub closure: Closure,
    /// Open, Close and Dance commands sent.
    pub commands: u32,
    /// Tesla's limit for this closure.
    pub limit: u32,
}

impl ClosureUsage {
    /// Whether the show sends more commands than the vehicle allows.
    #[must_use]
    pub const fn exceeded(&self) -> bool {
        self.commands > self.limit
    }
}

/// Counts the limited commands each closure receives.
///
/// A command is counted when a channel switches to Open, Close or Dance from a different
/// command; holding the same command over several frames counts once.
#[must_use]
pub fn closure_usage(show: &Sequence) -> Vec<ClosureUsage> {
    let channels = show.channel_count();
    Closure::ALL
        .iter()
        .filter_map(|&closure| {
            let index = Channel::Closure(closure).index()?;
            (index < channels).then_some((closure, index))
        })
        .map(|(closure, index)| {
            let mut previous = ClosureCommand::Idle;
            let mut commands = 0;
            for frame in show.frames() {
                let command = ClosureCommand::from_byte(frame[index]);
                if command != previous && command.counts_towards_limit() {
                    commands += 1;
                }
                previous = command;
            }
            ClosureUsage {
                closure,
                commands,
                limit: closure.command_limit(),
            }
        })
        .collect()
}
