use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::io::{Read, Write};
use std::time::Duration;

use serde_json::{Value, json};

use super::*;

fn pair() -> (Box<Display>, OwnedFd) {
    let mut fds = [-1; 2];
    // SAFETY: fds is writable for two descriptors; successful socketpair gives
    // each descriptor a unique owner immediately below.
    assert_eq!(
        unsafe {
            libc::socketpair(
                libc::AF_UNIX,
                libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC,
                0,
                fds.as_mut_ptr(),
            )
        },
        0
    );
    let (ours, peer) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    (Box::new(Display(engine::Display(ours))), peer)
}

fn span(text: &str) -> abi::Bytes {
    abi::Bytes::new(text.as_bytes())
}

fn packet(peer: &OwnedFd) -> Value {
    let mut bytes = vec![0; 65536];
    let got = peios::socket::recv_message(peer.as_fd(), &mut bytes, 0, 0).unwrap();
    assert!(!got.truncated);
    serde_json::from_slice(&bytes[..got.len]).unwrap()
}

fn send(peer: &OwnedFd, bytes: &[u8]) {
    peios::socket::send_message(peer.as_fd(), bytes, None, &[], libc::MSG_NOSIGNAL).unwrap();
}

fn receive(display: &Display) -> *mut Event {
    let mut event = ptr::null_mut();
    // SAFETY: display is borrowed live and event is writable output.
    assert_eq!(unsafe { peios_gxwi_receive(display, &mut event) }, 1);
    assert!(!event.is_null());
    event
}

#[test]
fn commands_preserve_wire_shapes_and_embedded_nul() {
    let (display, peer) = pair();
    let styles = [span("/one.css"), span("/two.css")];
    let options = abi::LiveOptions {
        surface: 9,
        title: span("Notes\0λ"),
        role: abi::ROLE_PANEL,
        edge: abi::EDGE_TOP,
        socket: span("/.fx/live/9"),
        styles: styles.as_ptr(),
        style_count: styles.len(),
    };
    // SAFETY: all handles, arrays and spans refer to live test-owned objects.
    unsafe {
        assert_eq!(peios_gxwi_create_live(&*display, &options), 0);
        assert_eq!(
            packet(&peer),
            json!({"type":"create","surface":9,"title":"Notes\0λ","role":"panel","edge":"top","kind":"live","socket":"/.fx/live/9","styles":["/one.css","/two.css"]})
        );
        assert_eq!(
            peios_gxwi_create_raw(&*display, 2, span("raw"), span("/page")),
            0
        );
        assert_eq!(
            packet(&peer),
            json!({"type":"create","surface":2,"title":"raw","kind":"raw","path":"/page"})
        );
        assert_eq!(peios_gxwi_title(&*display, 2, span("renamed")), 0);
        assert_eq!(
            packet(&peer),
            json!({"type":"title","surface":2,"title":"renamed"})
        );
        assert_eq!(peios_gxwi_destroy(&*display, 2), 0);
        assert_eq!(packet(&peer), json!({"type":"destroy","surface":2}));
    }
}

#[test]
fn shell_commands_remain_requests_without_client_side_authority() {
    let (display, peer) = pair();
    let arguments = [span("--name"), span("two words")];
    // SAFETY: all inputs are live and borrowed for these synchronous calls.
    unsafe {
        assert_eq!(
            peios_gxwi_start(
                &*display,
                span("program"),
                arguments.as_ptr(),
                arguments.len()
            ),
            0
        );
        assert_eq!(
            packet(&peer),
            json!({"type":"start","program":"program","arguments":["--name","two words"]})
        );
        assert_eq!(peios_gxwi_close(&*display, 72), 0);
        assert_eq!(packet(&peer), json!({"type":"close","id":72}));
        assert_eq!(peios_gxwi_log_off(&*display), 0);
        assert_eq!(packet(&peer), json!({"type":"log_off"}));
    }
}

#[test]
fn serve_transfers_an_owned_cloexec_peer_and_returns_a_working_stream() {
    let (display, peer) = pair();
    let mut fd = -1;
    // SAFETY: display is live, fd is writable, success transfers unique ownership.
    assert_eq!(unsafe { peios_gxwi_serve(&*display, &mut fd) }, 0);
    let mut ours = unsafe { UnixStream::from_raw_fd(fd) };
    let mut bytes = [0; 128];
    let received = peios::socket::recv_message(peer.as_fd(), &mut bytes, 1, 0).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes[..received.len]).unwrap(),
        json!({"type":"serve"})
    );
    assert_eq!(received.fds.len(), 1);
    let fd = received.fds.into_iter().next().unwrap();
    // SAFETY: both descriptors are live and F_GETFD does not mutate memory.
    assert_ne!(
        unsafe { libc::fcntl(ours.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
        0
    );
    assert_ne!(
        unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
        0
    );
    let mut theirs = UnixStream::from(fd);
    theirs
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    ours.write_all(b"http").unwrap();
    let mut message = [0; 4];
    theirs.read_exact(&mut message).unwrap();
    assert_eq!(&message, b"http");
    drop(ours);
    assert_eq!(theirs.read(&mut message).unwrap(), 0);
}

#[test]
fn events_outlive_display_and_views_borrow_only_the_event() {
    let (display, peer) = pair();
    send(&peer, json!({"type":"surfaces","surfaces":[
        {"id":3,"title":"Notes\0λ","role":"window","icon":"dev.peios.notes","app":8,"workspace":2,"own":0,"application":{"id":"dev.peios.notes","title":"Notes"}},
        {"id":4,"title":"Future","role":"unknown"},
        {"id":5,"title":"Panel","role":"panel","icon":"../wrong","workspace":u64::MAX}
    ]}).to_string().as_bytes());
    let event = receive(&display);
    let raw_display = Box::into_raw(display);
    // SAFETY: ownership transfers exactly once; event is independently owned.
    unsafe { peios_gxwi_display_destroy(raw_display) };
    let mut kind = 99;
    let mut count = 99;
    let mut view = mem::MaybeUninit::uninit();
    // SAFETY: event remains live and all outputs are writable. Views are read
    // only before this block releases the event.
    unsafe {
        assert_eq!(peios_gxwi_event_kind(event, &mut kind), 0);
        assert_eq!(kind, abi::EVENT_SURFACES);
        assert_eq!(peios_gxwi_event_surface_count(event, &mut count), 0);
        assert_eq!(count, 2);
        assert_eq!(peios_gxwi_event_surface(event, 0, view.as_mut_ptr()), 0);
        let view = view.assume_init();
        assert_eq!(text(view.title).unwrap(), "Notes\0λ");
        assert_eq!(
            view.flags,
            abi::LISTED_HAS_OWN | abi::LISTED_HAS_APPLICATION
        );
        assert_eq!((view.id, view.app, view.workspace, view.own), (3, 8, 2, 0));
        assert_eq!(text(view.application_id).unwrap(), "dev.peios.notes");
        let mut second = mem::MaybeUninit::uninit();
        assert_eq!(peios_gxwi_event_surface(event, 1, second.as_mut_ptr()), 0);
        let second = second.assume_init();
        assert_eq!(text(second.icon).unwrap(), "generic");
        assert_eq!((second.workspace, second.flags), (0, 0));
        peios_gxwi_event_destroy(event);
    }
}

#[test]
fn malformed_and_unknown_messages_remain_other_events() {
    let (display, peer) = pair();
    for message in [
        b"not JSON".as_slice(),
        b"{\"type\":\"future\"}",
        b"{\"type\":\"close\"}",
    ] {
        send(&peer, message);
        let event = receive(&display);
        let mut kind = 99;
        // SAFETY: event is owned and kind is writable; event is destroyed once.
        unsafe {
            assert_eq!(peios_gxwi_event_kind(event, &mut kind), 0);
            assert_eq!(kind, abi::EVENT_OTHER);
            peios_gxwi_event_destroy(event);
        }
    }
}

#[test]
fn typed_getters_reject_wrong_kind_and_out_of_range_without_writing() {
    let (display, peer) = pair();
    send(&peer, b"{\"type\":\"close\",\"surface\":42}");
    let event = receive(&display);
    let mut count = 123;
    let mut surface = 0;
    // SAFETY: owned live event and writable output values.
    unsafe {
        assert_eq!(peios_gxwi_event_close(event, &mut surface), 0);
        assert_eq!(surface, 42);
        assert_eq!(peios_gxwi_event_surface_count(event, &mut count), -1);
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::EINVAL)
        );
        assert_eq!(count, 123);
        peios_gxwi_event_destroy(event);
    }
    send(&peer, b"{\"type\":\"surfaces\",\"surfaces\":[]}");
    let event = receive(&display);
    let mut output = mem::MaybeUninit::uninit();
    // SAFETY: the event is live and output has capacity for a full view.
    unsafe {
        assert_eq!(peios_gxwi_event_surface(event, 0, output.as_mut_ptr()), -1);
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::ERANGE)
        );
        peios_gxwi_event_destroy(event);
    }
}

#[test]
fn invalid_utf8_null_spans_and_invalid_options_send_nothing() {
    let (display, peer) = pair();
    let invalid_utf8 = abi::Bytes::new(&[0xff]);
    let missing = abi::Bytes {
        data: ptr::null(),
        len: 1,
    };
    let invalid_options = abi::LiveOptions {
        surface: 0,
        title: span(""),
        role: 99,
        edge: 0,
        socket: span(""),
        styles: ptr::null(),
        style_count: 0,
    };
    // SAFETY: non-null inputs are valid; null spans are deliberate rejected cases.
    unsafe {
        assert_eq!(peios_gxwi_title(&*display, 1, invalid_utf8), -1);
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::EINVAL)
        );
        assert_eq!(peios_gxwi_title(&*display, 1, missing), -1);
        assert_eq!(peios_gxwi_create_live(&*display, &invalid_options), -1);
        assert_eq!(peios_gxwi_start(&*display, span("x"), ptr::null(), 1), -1);
        assert_eq!(peios_gxwi_destroy(&*display, 7), 0);
    }
    assert_eq!(packet(&peer), json!({"type":"destroy","surface":7}));
}

#[test]
fn empty_arrays_and_default_edge_are_preserved() {
    let (display, peer) = pair();
    let options = abi::LiveOptions {
        surface: 1,
        title: span(""),
        role: abi::ROLE_WINDOW,
        edge: abi::EDGE_DEFAULT,
        socket: span("s"),
        styles: ptr::null(),
        style_count: 0,
    };
    // SAFETY: null arrays have zero length and all other inputs are live.
    unsafe {
        assert_eq!(peios_gxwi_create_live(&*display, &options), 0);
        let message = packet(&peer);
        assert!(message.get("edge").is_none());
        assert_eq!(message["styles"], json!([]));
        assert_eq!(peios_gxwi_start(&*display, span("x"), ptr::null(), 0), 0);
        assert_eq!(packet(&peer)["arguments"], json!([]));
    }
}

#[test]
fn shutdown_wakes_a_concurrent_receiver_and_keeps_sending_open() {
    let (display, peer) = pair();
    std::thread::scope(|scope| {
        let display = &*display;
        let receiver = scope.spawn(|| {
            let mut event = ptr::null_mut();
            // SAFETY: scope keeps display live; event is writable.
            assert_eq!(unsafe { peios_gxwi_receive(display, &mut event) }, 0);
            assert!(event.is_null());
        });
        // SAFETY: shutdown may run concurrently with receive by the ABI contract.
        assert_eq!(unsafe { peios_gxwi_stop_listening(display) }, 0);
        receiver.join().unwrap();
        assert_eq!(unsafe { peios_gxwi_destroy(display, 8) }, 0);
        assert_eq!(packet(&peer), json!({"type":"destroy","surface":8}));
    });
}

#[test]
fn transport_failure_preserves_errno_and_output() {
    let (display, peer) = pair();
    drop(peer);
    let mut fd = 123;
    // SAFETY: display is live and fd is writable; failure must not change fd.
    assert_eq!(unsafe { peios_gxwi_serve(&*display, &mut fd) }, -1);
    assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::EPIPE));
    assert_eq!(fd, 123);
    let mut event = ptr::dangling_mut();
    assert_eq!(unsafe { peios_gxwi_receive(&*display, &mut event) }, 0);
    assert!(event.is_null());
}

#[test]
fn display_destruction_closes_owned_transport() {
    let (display, peer) = pair();
    // SAFETY: Box transfers ownership once; no reference survives destruction.
    unsafe { peios_gxwi_display_destroy(Box::into_raw(display)) };
    let mut bytes = [0; 1];
    assert_eq!(
        peios::socket::recv_message(peer.as_fd(), &mut bytes, 0, 0)
            .unwrap()
            .len,
        0
    );
}

#[test]
fn abi_layout_matches_the_public_c_header() {
    assert_eq!(mem::size_of::<abi::Bytes>(), 16);
    assert_eq!(mem::size_of::<abi::LiveOptions>(), 64);
    assert_eq!(mem::offset_of!(abi::LiveOptions, styles), 48);
    assert_eq!(mem::size_of::<abi::Listed>(), 104);
    assert_eq!(mem::offset_of!(abi::Listed, own), 64);
    assert_eq!(mem::offset_of!(abi::Listed, application_id), 72);
}

#[test]
fn truncated_json_prefix_is_not_treated_as_a_complete_request() {
    let (display, peer) = pair();
    let mut packet = b"{\"type\":\"close\",\"surface\":42}".to_vec();
    packet.resize(65536, b' ');
    packet.extend_from_slice(b" NOT JSON");
    send(&peer, &packet);
    let event = receive(&display);
    let mut kind = u32::MAX;
    // SAFETY: event is owned, kind writable, and event is released exactly once.
    unsafe {
        assert_eq!(peios_gxwi_event_kind(event, &mut kind), 0);
        assert_eq!(kind, abi::EVENT_OTHER);
        peios_gxwi_event_destroy(event);
    }
    send(&peer, b"{\"type\":\"close\",\"surface\":43}");
    let event = receive(&display);
    let mut surface = 0;
    unsafe {
        assert_eq!(peios_gxwi_event_close(event, &mut surface), 0);
        assert_eq!(surface, 43);
        peios_gxwi_event_destroy(event);
    }
}

#[test]
fn truncated_control_data_is_rejected_without_losing_the_next_packet() {
    let (display, peer) = pair();
    let (sent, mut stream_peer) = UnixStream::pair().unwrap();
    let attached = vec![sent.as_fd(); 32];
    peios::socket::send_message(
        peer.as_fd(),
        b"{\"type\":\"close\",\"surface\":42}",
        None,
        &attached,
        libc::MSG_NOSIGNAL,
    )
    .unwrap();
    let event = receive(&display);
    let mut kind = u32::MAX;
    // SAFETY: event is owned, kind writable, and event is released exactly once.
    unsafe {
        assert_eq!(peios_gxwi_event_kind(event, &mut kind), 0);
        assert_eq!(kind, abi::EVENT_OTHER);
        peios_gxwi_event_destroy(event);
    }
    drop(attached);
    drop(sent);
    stream_peer
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    assert_eq!(
        stream_peer.read(&mut [0]).unwrap(),
        0,
        "received descriptor copies must all close"
    );
    send(&peer, b"{\"type\":\"close\",\"surface\":43}");
    let event = receive(&display);
    let mut surface = 0;
    unsafe {
        assert_eq!(peios_gxwi_event_close(event, &mut surface), 0);
        assert_eq!(surface, 43);
        peios_gxwi_event_destroy(event);
    }
}
