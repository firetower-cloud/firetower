# Firetower on Linux

One download: `Firetower_<version>_amd64.AppImage`, on every
[release](https://github.com/firetower-cloud/firetower/releases). It carries
its own GTK and WebKit, so it runs on any reasonably current distribution
without installing anything, and it is the same application the Mac and
Windows builds are — the same window, the same servers, the same keychain.

It is **x86_64 only**: Intel and AMD. There is no ARM build, so a Raspberry Pi
or an ARM laptop cannot run it.

## Running it

```sh
chmod +x Firetower_*_amd64.AppImage
./Firetower_*_amd64.AppImage
```

**Keep it somewhere you can write to.** `~/Applications` or `~/bin` are both
fine; `/opt` and `/usr/local/bin` are not, unless you own them. This is the one
thing worth getting right before you start, because of the next section.

## It updates itself, by replacing that file

Firetower checks for a newer release, offers it, and — when you take it —
downloads it and writes it over **the AppImage you launched**. There is no
installer and nothing else on disk to update, so the file has to be one your
account can write to.

If it is not, the update fails and says so. There is no way for the
application to ask you for a password and carry on, as it can on Windows:
move the AppImage somewhere you can write to and take the update again. Your
servers, your sign-ins and your settings are kept elsewhere and are not
affected by moving it.

Every update is signed and the signature is checked before anything is
installed, exactly as on macOS and Windows.

## What does not work yet

Linux is tagged **Experimental** on the download page, and this is what that
means in practice. None of it stops the application working; all of it is
known, and none of it is a bug worth reporting.

* **No tray icon.** Firetower does not appear in a system tray or indicator
  area. Nothing in the application points at one, so there is no gap where
  something should be — closing the window closes the application.
* **No badge on the dock or taskbar.** The count of things waiting for you is
  in the window — on the rail, and on each panel — but not on the launcher
  icon. It needs a running Unity session, which nothing ships any more.
* **No poster images on artifacts.** The desk builds photograph an artifact so
  the list shows what each one looks like. That is macOS and Windows only, so
  here the artifacts are a list with their names and nothing to look at until
  you open one.
* **The top corners of the window do not resize diagonally.** The window has
  no system title bar — Firetower draws its own — and the top five pixels are
  the toolkit's, which treats the whole of that edge as *top*. Drag a bottom
  corner to resize both directions at once, or the top edge and a side in
  turn. Every other edge and both bottom corners behave normally.
* **WebKit's subprocess sandbox is off**, as it is in every stock Tauri
  application on Linux. Turning it on needs a hook the framework does not
  offer before the window is created, and the alternative — forcing it with an
  environment variable — leaves the application with no window at all on any
  machine where unprivileged user namespaces are disabled. We would rather
  ship something that runs. The web view still enforces the content-security
  policy, and the application talks only to the servers you connect it to.

## The `.deb` that is not here

Earlier builds were published as a `.deb` as well, and were installed that
way by the people who tried them. The release carries only the AppImage.

A `.deb` cannot update itself: the only way to replace one in place is
`dpkg -i` as root, which an application cannot ask for in the middle of an
update. So a released `.deb` would be a copy of Firetower that quietly stayed
where it was while every other platform moved — and a download that cannot
keep itself current is worse than one more step at installation time.

It can come back, and it is meant to, once there is an apt repository to serve
it from: that is what makes `apt upgrade` the update mechanism, which is the
right one on a machine where you already have a package manager. Until then,
one download.

The per-pull-request builds still produce a `.deb` and still will — see
[`desktop.yml`](../.github/workflows/desktop.yml) and the *Artifacts* box on
any run of it — so a branch can still be tried that way.

## If something is wrong

Open an issue with the distribution, its version, and whether you are on
Wayland or X11 (`echo $XDG_SESSION_TYPE`). Running it from a terminal and
pasting what it printed is worth more than a description of the window: the
failures that are particular to this build are nearly all in the first few
lines of output, and the window may show nothing at all when one of them
happens.
