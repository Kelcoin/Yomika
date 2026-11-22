//! Orders native scroll samples against delayed layout snapshots and JS jumps.
#[derive(Clone, Copy, Debug, Default, serde::Deserialize)]
pub(crate) struct ContinuousInputStamp {
    pub session: u32,
    pub revision: u32,
    pub sample: u32,
}

#[derive(Default)]
pub(super) struct ContinuousInput {
    pub stamp: ContinuousInputStamp,
    pub active: bool,
    pub reduce_motion: bool,
    pub offset: f64,
    limit: f64,
}

impl ContinuousInput {
    pub fn configure(&mut self, session: u32, active: bool, limit: f64, offset: f64, reduce_motion: bool) {
        if session < self.stamp.session { return; }
        if session != self.stamp.session {
            *self = Self::default();
            self.stamp.session = session;
        }
        if !self.active || !active { self.offset = offset; }
        self.active = active;
        self.reduce_motion = reduce_motion;
        self.limit = limit;
        self.offset = self.offset.clamp(0.0, limit);
    }

    pub fn accept_layout(&mut self, stamp: Option<ContinuousInputStamp>, offset: f64) -> f64 {
        if self.active && stamp.is_none_or(|stamp| {
            stamp.session != self.stamp.session || stamp.revision != self.stamp.revision || stamp.sample < self.stamp.sample
        }) {
            self.offset
        } else {
            self.offset = offset.clamp(0.0, self.limit);
            offset
        }
    }

    pub fn reposition(&mut self, session: u32, revision: u32, offset: f64, relative: bool) -> bool {
        if self.stamp.session != session || revision <= self.stamp.revision { return false; }
        self.stamp.revision = revision;
        self.scroll_to(if relative && self.active { self.offset + offset } else { offset });
        true
    }

    pub fn scroll_to(&mut self, offset: f64) -> bool {
        let offset = offset.clamp(0.0, self.limit);
        let changed = self.offset != offset;
        self.offset = offset;
        if changed { self.stamp.sample += 1; }
        changed
    }
}
