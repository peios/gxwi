//! The token gxwi-server runs under: gxwid's own, restricted until it can
//! reach only what gxwid deliberately grants it.
//!
//! A restricted token is checked twice, and the second pass matches nothing
//! but the restricting SIDs — not the user SID, not `Everyone`. With one
//! restricting SID that exists only for this purpose, the server can open an
//! object only if its descriptor names both SYSTEM and that SID.

use peios::security::{Privileges, Sid};
use peios::token::{RestrictSpec, Token, TokenAccess};

/// The capability whose SID restricts gxwi-server. Granting this capability to
/// anything else grants it everything the network-facing process can reach.
pub const NET_CAPABILITY: &str = "dev.peios.gxwi.net";

// PCDS derived capability: S-1-15-3 followed by eight little-endian u32
// sub-authorities from SHA-256 of the UTF-8 name. Held as a constant, which
// the test below pins to the name, so that a change to the name is a change
// someone sees here.
const NET_CAPABILITY_SUB_AUTHORITIES: [u32; 8] = [
    165089264, 3223449312, 1247726440, 2294222582, 3667604814, 1924088670, 4213972040, 4159405878,
];

const APP_PACKAGE_AUTHORITY: u64 = 15;
const CAPABILITY_RID: u32 = 3;

pub fn net_capability_sid() -> peios::Result<Sid> {
    let mut subs = vec![CAPABILITY_RID];
    subs.extend_from_slice(&NET_CAPABILITY_SUB_AUTHORITIES);
    Sid::build(APP_PACKAGE_AUTHORITY, &subs)
}

/// Builds the server's token from gxwid's own.
pub fn server_token() -> peios::Result<Token> {
    // ASSIGN_PRIMARY as well as DUPLICATE: the token `restrict` returns carries
    // the access mask of the one it was made from, and install needs
    // ASSIGN_PRIMARY on the token being installed.
    let me = Token::open_self(
        true,
        TokenAccess::DUPLICATE | TokenAccess::QUERY | TokenAccess::ASSIGN_PRIMARY,
    )?;
    let spec = RestrictSpec {
        // Privilege-granted access is restored after the restricted pass, so
        // restriction alone would leave every privilege usable. CHANGE_NOTIFY
        // stays: without it each directory on the way to the server's own
        // binary would have to grant traverse to the capability.
        privs_to_delete: Privileges::all() - Privileges::CHANGE_NOTIFY,
        restrict_sids: vec![net_capability_sid()?],
        ..RestrictSpec::default()
    };
    me.restrict(&spec)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn sub_authorities_are_derived_from_the_name() {
        let hash = Sha256::digest(NET_CAPABILITY.as_bytes());
        let derived: Vec<u32> = hash
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| u32::from_le_bytes(*c))
            .collect();
        assert_eq!(derived, NET_CAPABILITY_SUB_AUTHORITIES);
    }
}
