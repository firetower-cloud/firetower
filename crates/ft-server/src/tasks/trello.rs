//! Trello, read through its search.
//!
//! Three things shape this file.
//!
//! Every listing is one call to `/1/search`, never a walk over boards and
//! lists. Search is the only Trello endpoint that takes the whole question at
//! once (words, a column, a label, a member, open or archived, across every
//! board the token can see), so the filter travels as a parameter and the
//! page that comes back is already the right thirty. It also answers each card
//! with its list and members when asked, which is how a card learns its
//! column without a second request. Search gives no total and no cursor, only
//! a page number, so [`Page::more`] is "a full page came back".
//!
//! The one exception is a board column with nothing typed: it is a Trello
//! list, asked by the list's id through `/lists/{id}/cards`, because that is
//! the only call that returns a list's cards exactly, in the board's own
//! order. Search matches `list:` by word, so "Urgent" would also bring the
//! cards of "Non urgent". When a column is searched anyway (something typed,
//! or Assigned to me), the answer is checked against the list id.
//!
//! The credentials never appear in a URL. Trello will take `key` and `token`
//! as query parameters, and those end up in proxy logs, error messages and
//! `Debug` output. They go in an `Authorization: OAuth` header instead, which
//! is why none of the parameters built here mention them.
//!
//! A card is keyed by its `shortLink`, the eight characters in
//! `trello.com/c/<shortLink>`. It is stable when the card is renamed or moved,
//! it is what a pasted link carries, and it matches neither `#5138` nor
//! `ENG-123`, so nothing downstream mistakes a card for an issue it can write
//! a `Closes` trailer for.
//!
//! As elsewhere, a typed qualifier beats the chip beside it.

use anyhow::{bail, Context, Result};
use serde::{de::DeserializeOwned, Deserialize};

use super::{Label, Page, Person, Query, Source, Task, TaskAttachment, TaskKind, TaskState};
use crate::trackers::Tracker;

/// Trello as a [`Source`].
///
/// Holds the app key beside the tracker because the trait hands every source
/// one credential, and Trello needs two: the key identifies Firetower, the
/// token (the `token` argument) identifies the person.
pub struct Trello<'a> {
    pub tracker: &'a Tracker,
    pub app_key: String,
}

impl Trello<'_> {
    /// A list's name, which search wants for `list:"…"` and which a card
    /// from `/lists/{id}/cards` does not carry.
    async fn list_name(&self, token: &str, id: &str) -> Result<String> {
        let list: ListName = ask_trello(
            self.tracker.api_base,
            &self.app_key,
            token,
            &format!("/lists/{id}"),
            &[("fields", "name".to_string())],
        )
        .await?;
        Ok(list.name)
    }
}

impl Source for Trello<'_> {
    async fn list(&self, token: &str, ask: &Query) -> Result<Page> {
        // Trello has no pull requests. Asking for them asks for nothing.
        if ask.kind == Some(TaskKind::PullRequest) {
            return Ok(Page {
                tasks: Vec::new(),
                total: None,
                more: false,
                next: None,
            });
        }

        // The scope is a board's id, which is what search wants as it is.
        let board = ask.team.as_deref().filter(|t| !t.is_empty());
        if let Some(board) = board {
            if !is_board_id(board) {
                bail!("{board} is not a Trello board");
            }
        }

        // A column is a list, named by its id. Checked before anything is sent.
        let column = column_of(ask)?;

        // The list's name and its cards do not wait on each other, so they
        // are asked at once: a board of six columns is six of these.
        if let (Some(id), Way::WholeList) = (column, way_of(ask)) {
            let path = format!("/lists/{id}/cards");
            let params = list_params(ask);
            let (name, cards): (String, Vec<Card>) = tokio::try_join!(
                self.list_name(token, id),
                ask_trello(self.tracker.api_base, &self.app_key, token, &path, &params),
            )?;
            return Ok(Page {
                tasks: in_column(cards, &name),
                total: None,
                more: false,
                next: None,
            });
        }

        let list_name = match column {
            Some(id) => Some(self.list_name(token, id).await?),
            None => None,
        };

        #[derive(Deserialize)]
        struct Found {
            #[serde(default)]
            cards: Vec<Card>,
        }

        // Search matches `list:` by word, so the column's name goes in as
        // the query asks and the answer is checked against the column's id.
        let named = Query {
            status: list_name,
            ..ask.clone()
        };
        let found: Found = ask_trello(
            self.tracker.api_base,
            &self.app_key,
            token,
            "/search",
            &search_params(&named, board),
        )
        .await?;

        // A full page is what Trello sent, before Firetower checked it.
        let more = found.cards.len() as u32 >= super::PER_PAGE;
        let cards = match column {
            Some(id) => in_list(found.cards, id),
            None => found.cards,
        };
        Ok(Page {
            tasks: cards.into_iter().map(Into::into).collect(),
            total: None,
            more,
            next: None,
        })
    }

    async fn one(&self, token: &str, url: &str) -> Result<Task> {
        let short_link = card_of(url)
            .filter(|link| is_short_link(link))
            .with_context(|| format!("{url} is not a Trello card"))?;

        let card: Card = ask_trello(
            self.tracker.api_base,
            &self.app_key,
            token,
            &format!("/cards/{short_link}"),
            &[
                ("members", "true".to_string()),
                ("member_fields", "username,avatarUrl".to_string()),
                ("list", "true".to_string()),
            ],
        )
        .await?;
        // Without its attachments: session bring-up reads a card through
        // here and never wants them, and a second request that fails would
        // take the title and the body down with it. `card_attachments` is
        // asked separately, by the one caller that shows them.
        Ok(card.into())
    }
}

/// A card's attachments, by its link. Asked apart from [`Trello::one`] so
/// that failing to read them never costs the card itself.
pub async fn card_attachments(
    api_base: &str,
    app_key: &str,
    token: &str,
    url: &str,
) -> Result<Vec<TaskAttachment>> {
    attachments_of(api_base, app_key, token, card_in(url)?).await
}

/// The shortLink of a card link, or [`Unserved::NotACard`]: a board link,
/// another host, or anything that cannot go into a path.
fn card_in(url: &str) -> Result<&str, Unserved> {
    card_of(url)
        .filter(|link| is_short_link(link))
        .ok_or(Unserved::NotACard)
}

/// What `/cards/{shortLink}/attachments` is asked for: exactly what a
/// [`TaskAttachment`] holds.
const ATTACHMENT_FIELDS: &str = "id,name,mimeType,bytes,url,isUpload";

/// A card's attachments, files and links together, in Trello's order.
async fn attachments_of(
    api_base: &str,
    app_key: &str,
    token: &str,
    short_link: &str,
) -> Result<Vec<TaskAttachment>> {
    let raw: Vec<RawAttachment> = ask_trello(
        api_base,
        app_key,
        token,
        &format!("/cards/{short_link}/attachments"),
        &[("fields", ATTACHMENT_FIELDS.to_string())],
    )
    .await?;
    Ok(raw.into_iter().map(Into::into).collect())
}

/// The most one attachment may weigh on its way through.
///
/// The desktop's largest attach cap (`BIGGEST_FILE` in `ui/attach.tsx`), so a
/// file the composer would refuse is refused here before it is downloaded,
/// rather than carried across the network to be refused there.
pub const BIGGEST_ATTACHMENT: u64 = 25 * 1024 * 1024;

/// Why an attachment's bytes are not served.
///
/// A type of its own so the API can answer each as what it is (not there, or
/// too big) instead of as a server fault.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unserved {
    /// The link is not a Trello card: a board, or not Trello at all.
    NotACard,
    /// The id is not on this card's list. Also what any other id gets, so
    /// nothing can be asked for that the card does not hold.
    NotOnCard,
    /// It is a link, which has no bytes Firetower could bring along.
    NotAFile,
    /// Heavier than [`BIGGEST_ATTACHMENT`].
    TooBig,
}

impl std::fmt::Display for Unserved {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Unserved::NotACard => "That link is not a Trello card.",
            Unserved::NotOnCard => "That attachment is not on this card.",
            Unserved::NotAFile => "That attachment is a link, not a file.",
            Unserved::TooBig => "That attachment is over 25 MB.",
        })
    }
}

impl std::error::Error for Unserved {}

/// The attachment this id names, if the card holds it and it may be served.
///
/// The one place that decides. The id is matched against the list Trello has
/// just given for the card, never against anything the caller sent, which is
/// what keeps this from fetching an address somebody chose.
fn served<'a>(list: &'a [TaskAttachment], id: &str) -> Result<&'a TaskAttachment, Unserved> {
    let found = list
        .iter()
        .find(|a| a.id == id)
        .ok_or(Unserved::NotOnCard)?;
    if !found.upload {
        return Err(Unserved::NotAFile);
    }
    if found.bytes.is_some_and(|n| !fits(n)) {
        return Err(Unserved::TooBig);
    }
    Ok(found)
}

/// Whether this many bytes may be served. Asked of the size Trello states and
/// again of what has actually arrived, which is what counts.
fn fits(bytes: u64) -> bool {
    bytes <= BIGGEST_ATTACHMENT
}

/// An attachment id has the same shape as a board id, and is checked for the
/// same reason before it goes into a path.
pub fn is_attachment_id(id: &str) -> bool {
    is_board_id(id)
}

/// A file name as the last segment of the download path.
///
/// Trello ignores that segment (any name downloads the same bytes), but it
/// still goes into a URL, so only letters, digits, `.`, `-` and `_` stay and
/// nothing may start with a dot.
fn file_segment(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
            out.push(c);
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    let out = out
        .trim_start_matches(['.', '_'])
        .trim_end_matches('_')
        .to_string();
    if out.trim_matches('.').is_empty() {
        "file".to_string()
    } else {
        out
    }
}

/// One attachment's bytes, by the card it is on and its id.
///
/// Trello wants the credential even to download, so a person's machine
/// cannot fetch the file itself and Firetower does it for them. The card's
/// list is read again first, and only an id on it is downloaded: the request
/// is built from the card and that id, never from a URL.
pub async fn attachment(
    api_base: &str,
    app_key: &str,
    token: &str,
    url: &str,
    id: &str,
) -> Result<(TaskAttachment, Vec<u8>)> {
    let short_link = card_in(url)?;
    if !is_attachment_id(id) {
        return Err(Unserved::NotOnCard.into());
    }

    let list = attachments_of(api_base, app_key, token, short_link).await?;
    let found = served(&list, id)?.clone();

    let path = format!(
        "/cards/{short_link}/attachments/{id}/download/{}",
        file_segment(&found.name)
    );
    let response = send_trello(api_base, app_key, token, &path, &[]).await?;
    let declared = response.content_length();
    let chunks = futures::stream::unfold(response, |mut response| async move {
        match response.chunk().await {
            Ok(Some(chunk)) => Some((Ok(chunk), response)),
            Ok(None) => None,
            Err(e) => Some((
                Err(anyhow::Error::new(e).context("reading what Trello sent")),
                response,
            )),
        }
    });
    let bytes = read_capped(declared, BIGGEST_ATTACHMENT, chunks).await?;
    Ok((found, bytes))
}

/// A download read to the end, refused as [`Unserved::TooBig`] the moment it
/// is heavier than `cap`.
///
/// Twice over: by the size it declares, before a byte is read, and by what
/// has actually arrived, because a declared length is only a claim. Takes the
/// chunks as a stream so the decision can be tested without a network.
async fn read_capped<B, S>(declared: Option<u64>, cap: u64, chunks: S) -> Result<Vec<u8>>
where
    B: AsRef<[u8]>,
    S: futures::Stream<Item = Result<B>>,
{
    use futures::StreamExt;

    if declared.is_some_and(|n| n > cap) {
        return Err(Unserved::TooBig.into());
    }
    let mut chunks = std::pin::pin!(chunks);
    let mut bytes = Vec::new();
    while let Some(chunk) = chunks.next().await {
        bytes.extend_from_slice(chunk?.as_ref());
        if bytes.len() as u64 > cap {
            return Err(Unserved::TooBig.into());
        }
    }
    Ok(bytes)
}

/// A shortLink is letters and digits. Checked before one is put in a path, so
/// a pasted link cannot steer the request somewhere else on the API.
pub fn is_short_link(link: &str) -> bool {
    !link.is_empty() && link.chars().all(|c| c.is_ascii_alphanumeric())
}

/// A board id is what the API calls it: twenty-four lowercase hex digits.
/// Checked before one is put in a path, for the same reason as a shortLink.
pub fn is_board_id(id: &str) -> bool {
    id.len() == 24 && id.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

/// A list id has the same shape as a board id, and is checked for the same
/// reason before it goes into a path.
pub fn is_list_id(id: &str) -> bool {
    is_board_id(id)
}

/// The token out of whatever was pasted.
///
/// Trello's authorize page shows a bare token, but people also copy the whole
/// address after approving, or a `#token=…` fragment, or the line
/// `token=…`. All of them should connect, so a `token=` value is taken
/// wherever it sits and anything else is the token itself, trimmed.
pub fn token_in(pasted: &str) -> &str {
    let pasted = pasted.trim();
    let Some(at) = pasted.find("token=") else {
        return pasted;
    };
    let value = &pasted[at + "token=".len()..];
    let end = value
        .find(|c: char| c == '&' || c == '#' || c.is_whitespace())
        .unwrap_or(value.len());
    value[..end].trim_matches('"')
}

/// Who the token belongs to. Used to refuse one that does not work at the
/// moment it is offered, rather than storing it and failing on the next screen.
pub async fn viewer(api_base: &str, app_key: &str, token: &str) -> Result<String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Me {
        #[serde(default)]
        full_name: String,
        username: String,
    }

    let me: Me = ask_trello(
        api_base,
        app_key,
        token,
        "/members/me",
        &[("fields", "fullName,username".to_string())],
    )
    .await?;
    Ok(if me.full_name.trim().is_empty() {
        me.username
    } else {
        me.full_name
    })
}

/// A board the token can see. What the scope picker offers.
#[derive(Debug, Clone)]
pub struct Board {
    /// The board's id. Search narrows by it and `/boards/{id}/lists` takes
    /// it, so the scope needs no lookup before either.
    pub key: String,
    pub name: String,
}

/// A board as `/members/me/boards` answers. The id comes back whether or not
/// `fields` names it.
#[derive(Deserialize)]
struct RawBoard {
    id: String,
    name: String,
}

pub async fn boards(api_base: &str, app_key: &str, token: &str) -> Result<Vec<Board>> {
    let raw: Vec<RawBoard> = ask_trello(
        api_base,
        app_key,
        token,
        "/members/me/boards",
        &[
            ("filter", "open".to_string()),
            ("fields", "name".to_string()),
        ],
    )
    .await?;
    Ok(in_name_order(raw))
}

fn in_name_order(raw: Vec<RawBoard>) -> Vec<Board> {
    let mut boards: Vec<Board> = raw
        .into_iter()
        .map(|b| Board {
            key: b.id,
            name: b.name,
        })
        .collect();
    boards.sort_by_key(|b| b.name.to_lowercase());
    boards
}

/// A column of a board, as the board view lays them side by side.
#[derive(Debug, Clone)]
pub struct Column {
    /// The list's id.
    pub key: String,
    /// What the list is called, which is also what `list:"…"` searches by.
    pub name: String,
}

/// A list as Trello answers for a board.
#[derive(Deserialize)]
struct List {
    id: String,
    name: String,
    /// Where it sits on the board. Fractional: Trello halves the gap when a
    /// list is dropped between two others.
    pos: f64,
}

/// A board's open lists, left to right.
///
/// Asked of Trello rather than read off a page of cards: a page holds thirty
/// cards, so a column with nothing recent in it, or an empty one, would
/// otherwise be missing from the board.
pub async fn columns(
    api_base: &str,
    app_key: &str,
    token: &str,
    board: &str,
) -> Result<Vec<Column>> {
    if !is_board_id(board) {
        bail!("{board} is not a Trello board");
    }
    let lists: Vec<List> = ask_trello(
        api_base,
        app_key,
        token,
        &format!("/boards/{board}/lists"),
        &[
            ("filter", "open".to_string()),
            ("fields", "name,pos".to_string()),
        ],
    )
    .await?;
    Ok(in_board_order(lists))
}

/// Trello does not promise the order it answers in; `pos` is the order.
fn in_board_order(mut lists: Vec<List>) -> Vec<Column> {
    lists.sort_by(|a, b| a.pos.total_cmp(&b.pos));
    lists
        .into_iter()
        .map(|l| Column {
            key: l.id,
            name: l.name,
        })
        .collect()
}

/// One request, and the handling every caller would repeat.
///
/// The key and the token travel in the `Authorization` header and nowhere
/// else: in a query string they would end up in proxy logs, in error messages
/// and in anything that prints the URL.
async fn ask_trello<T: DeserializeOwned>(
    api_base: &str,
    app_key: &str,
    token: &str,
    path: &str,
    params: &[(&str, String)],
) -> Result<T> {
    send_trello(api_base, app_key, token, path, params)
        .await?
        .json()
        .await
        .context("reading what Trello sent")
}

/// The request [`ask_trello`] makes, answered as it came rather than read as
/// JSON, which is what a download needs. Same header, same refusal.
async fn send_trello(
    api_base: &str,
    app_key: &str,
    token: &str,
    path: &str,
    params: &[(&str, String)],
) -> Result<reqwest::Response> {
    let mut authorization = reqwest::header::HeaderValue::from_str(&format!(
        r#"OAuth oauth_consumer_key="{app_key}", oauth_token="{token}""#
    ))
    .context("that token cannot be sent")?;
    authorization.set_sensitive(true);

    let response = crate::oauth::client()?
        .get(format!("{api_base}{path}"))
        .header(reqwest::header::AUTHORIZATION, authorization)
        .query(params)
        .send()
        .await
        .context("asking Trello")?;

    if let Some(left) = response
        .headers()
        .get("x-rate-limit-api-token-remaining")
        .and_then(|v| v.to_str().ok())
    {
        tracing::debug!("trello requests left this window: {left}");
    }

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(
            super::Refused("Trello refused the token. It may have been revoked.".into()).into(),
        );
    }

    response
        .error_for_status()
        .context("Trello refused the request")
}

/// `https://trello.com/c/aB3dE9fG/42-fix-export` → `aB3dE9fG`.
///
/// Forgiving about the tail for the same reason the others are: a link out of
/// the address bar carries a slug, often a trailing slash, and sometimes a
/// comment anchor. A board link, or any other host, is not a card.
pub fn card_of(url: &str) -> Option<&str> {
    // The scheme only counts at the start: `evil.io/?u=https://trello.com/...`
    // is not a Trello link.
    let rest = ["https://", "http://"]
        .iter()
        .find_map(|scheme| {
            let head = url.get(..scheme.len())?;
            head.eq_ignore_ascii_case(scheme)
                .then(|| &url[scheme.len()..])
        })
        .unwrap_or(url);
    let path = rest.split(['?', '#']).next()?;
    let mut parts = path.split('/');

    let host = parts.next()?;
    if !host.eq_ignore_ascii_case("trello.com") && !host.eq_ignore_ascii_case("www.trello.com") {
        return None;
    }
    if parts.next()? != "c" {
        return None;
    }
    parts.next().filter(|link| !link.is_empty())
}

/// Trello's label colour names, as six hex digits.
///
/// The API says `green` or `red_dark`, never a hex. These hexes are
/// Atlassian's current label palette as importers and exporters map it, not
/// something the API states, so a shade can drift from what Trello draws. A
/// name it adds later maps to `None` rather than to a guess, and the label
/// shows without a colour.
fn colour_of(name: &str) -> Option<&'static str> {
    Some(match name {
        "green" => "4bce97",
        "green_dark" => "1f845a",
        "green_light" => "baf3db",
        "yellow" => "f5cd47",
        "yellow_dark" => "946f00",
        "yellow_light" => "f8e6a0",
        "orange" => "fea362",
        "orange_dark" => "c25100",
        "orange_light" => "fedec8",
        "red" => "f87168",
        "red_dark" => "c9372c",
        "red_light" => "ffd5d2",
        "purple" => "9f8fef",
        "purple_dark" => "6e5dc6",
        "purple_light" => "dfd8fd",
        "blue" => "579dff",
        "blue_dark" => "0c66e4",
        "blue_light" => "cce0ff",
        "sky" => "6cc3e0",
        "sky_dark" => "227d9b",
        "sky_light" => "c6edfb",
        "lime" => "94c748",
        "lime_dark" => "5b7f24",
        "lime_light" => "d3f1a7",
        "pink" => "e774bb",
        "pink_dark" => "ae4787",
        "pink_light" => "fdd0ec",
        "black" => "8590a2",
        "black_dark" => "626f86",
        "black_light" => "dcdfe4",
        _ => return None,
    })
}

/// What somebody typed in the box, read for the qualifiers Trello has.
///
/// Values may be quoted, because a column is often called "In progress".
#[derive(Debug, Default, PartialEq, Eq)]
struct Typed {
    board: Option<String>,
    list: Option<String>,
    labels: Vec<String>,
    member: Option<String>,
    state: Option<TaskState>,
    /// Everything that was not a qualifier, a word at a time.
    text: Vec<String>,
}

impl Typed {
    fn read(raw: &str) -> Self {
        let mut out = Typed::default();

        for word in words(raw) {
            let Some((name, value)) = word.split_once(':') else {
                out.text.push(word);
                continue;
            };
            let value = value.trim_matches('"').to_string();
            if value.is_empty() {
                out.text.push(word);
                continue;
            }
            match name.to_ascii_lowercase().as_str() {
                "board" => out.board = Some(value),
                "list" => out.list = Some(value),
                "label" => out.labels.push(value),
                "member" => out.member = Some(value.trim_start_matches('@').to_string()),
                "is" if value.eq_ignore_ascii_case("open") => out.state = Some(TaskState::Open),
                "is" if value.eq_ignore_ascii_case("archived") => {
                    out.state = Some(TaskState::Closed)
                }
                _ => out.text.push(word),
            }
        }

        out
    }
}

/// Whitespace-separated words, except that a quote keeps its spaces:
/// `list:"In progress"` is one word.
fn words(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut inside = false;

    for c in raw.chars() {
        match c {
            '"' => {
                inside = !inside;
                word.push(c);
            }
            c if c.is_whitespace() && !inside => {
                if !word.is_empty() {
                    out.push(std::mem::take(&mut word));
                }
            }
            c => word.push(c),
        }
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

/// A value as Trello's search wants it: quoted only when it has to be.
fn quoted(value: &str) -> String {
    if value.contains(char::is_whitespace) {
        format!("\"{value}\"")
    } else {
        value.to_string()
    }
}

/// What `query` says when nothing was typed and no chip is set.
///
/// Trello's search refuses an empty `query` (it wants one to 16384
/// characters), yet "show this board" is the ordinary case. Search leaves
/// archived cards out unless `is:archived` is asked for, so `is:open` is the
/// nearest thing to "no filter" that the dialect has: it says out loud what
/// Trello would have assumed anyway.
const WHEN_NOTHING_IS_ASKED: &str = "is:open";

/// The chips and the box, as the string Trello's search reads.
fn query_for(ask: &Query) -> String {
    let typed = Typed::read(ask.raw.as_deref().unwrap_or("").trim());
    let mut parts: Vec<String> = typed.text;

    if let Some(board) = &typed.board {
        parts.push(format!("board:{}", quoted(board)));
    }
    // A typed `list:` beats the column asked for beside it, like every chip.
    if let Some(list) = typed.list.as_ref().or(ask.status.as_ref()) {
        parts.push(format!("list:{}", quoted(list)));
    }
    for label in &typed.labels {
        parts.push(format!("label:{}", quoted(label)));
    }

    match &typed.member {
        Some(who) => parts.push(format!("@{who}")),
        None if ask.mine => parts.push("@me".into()),
        None => {}
    }

    match typed.state.or(ask.state) {
        Some(TaskState::Open) => parts.push("is:open".into()),
        Some(TaskState::Closed) => parts.push("is:archived".into()),
        None => {}
    }

    if parts.is_empty() {
        return WHEN_NOTHING_IS_ASKED.into();
    }
    parts.join(" ")
}

/// How a column is asked for.
#[derive(Debug, PartialEq, Eq)]
enum Way {
    /// `/lists/{id}/cards`: the list's own cards, in Trello's own order.
    /// Only when nothing narrows the column, because that endpoint takes no
    /// query, no member and no label.
    WholeList,
    /// `/search`, which is the only call that takes a question. Cards come
    /// back in search order, not the board's.
    Search,
}

/// Whole list or search: nothing typed and not "Assigned to me" is the list.
fn way_of(ask: &Query) -> Way {
    let nothing_typed = ask.raw.as_deref().unwrap_or("").trim().is_empty();
    if ask.status.is_some() && nothing_typed && !ask.mine {
        Way::WholeList
    } else {
        Way::Search
    }
}

/// The column asked for, as a list id that may go into a path.
fn column_of(ask: &Query) -> Result<Option<&str>> {
    match ask.status.as_deref().filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(id) if is_list_id(id) => Ok(Some(id)),
        Some(other) => bail!("{other} is not a Trello list"),
    }
}

/// What `/lists/{id}/cards` is called with: the state chip as Trello's
/// `filter` (open when there is none), and the members a row draws.
fn list_params(ask: &Query) -> Vec<(&'static str, String)> {
    let filter = match ask.state {
        Some(TaskState::Closed) => "closed",
        _ => "open",
    };
    vec![
        ("filter", filter.to_string()),
        ("members", "true".to_string()),
        ("member_fields", "username,avatarUrl".to_string()),
    ]
}

/// A list's cards as tasks, each in the list it was asked from. The endpoint
/// does not embed the list, so its name is put on them here.
fn in_column(cards: Vec<Card>, name: &str) -> Vec<Task> {
    cards
        .into_iter()
        .map(|mut card| {
            card.list = Some(ListName { name: name.into() });
            card.into()
        })
        .collect()
}

/// The cards that sit in exactly this list.
///
/// The one place Firetower checks what Trello returned. Search's `list:`
/// matches words, not names, so asking for "Urgent" also brings back the
/// cards of "Non urgent". Cards with no `idList` are kept out.
fn in_list(cards: Vec<Card>, id: &str) -> Vec<Card> {
    cards
        .into_iter()
        .filter(|card| card.id_list.as_deref() == Some(id))
        .collect()
}

/// Every parameter `/1/search` is called with.
///
/// `cards_page` counts from zero where [`Query::page`] counts from one. The
/// board, when one is picked, goes by id: search takes ids, and the scope key
/// is that id, so it needs no lookup first.
pub fn search_params(ask: &Query, board_id: Option<&str>) -> Vec<(&'static str, String)> {
    let mut params = vec![
        ("query", query_for(ask)),
        ("modelTypes", "cards".to_string()),
        ("cards_limit", super::PER_PAGE.to_string()),
        ("cards_page", ask.page.saturating_sub(1).to_string()),
        // The column, the board and the people, in the same answer.
        ("card_list", "true".to_string()),
        ("card_members", "true".to_string()),
    ];
    if let Some(id) = board_id {
        params.push(("idBoards", id.to_string()));
    }
    params
}

/// A card as search answers it, with its list and members attached.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    short_link: String,
    name: String,
    #[serde(default)]
    desc: String,
    short_url: String,
    /// Archived. Trello's "done".
    #[serde(default)]
    closed: bool,
    date_last_activity: chrono::DateTime<chrono::Utc>,
    #[serde(default)]
    labels: Vec<Tag>,
    #[serde(default)]
    members: Vec<Member>,
    /// The column. Absent when the request did not ask for it.
    list: Option<ListName>,
    /// The column's id, which search's `list:` word match is checked against.
    id_list: Option<String>,
}

/// An attachment as `/cards/{shortLink}/attachments` answers it.
///
/// Every field but the id may be missing or empty: a link has no type and no
/// size, and Trello leaves out what it was not asked for.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAttachment {
    id: String,
    #[serde(default)]
    name: String,
    /// `""` for a link, rather than absent.
    mime_type: Option<String>,
    bytes: Option<u64>,
    #[serde(default)]
    url: String,
    #[serde(default)]
    is_upload: bool,
}

impl From<RawAttachment> for TaskAttachment {
    fn from(raw: RawAttachment) -> Self {
        TaskAttachment {
            // A link pasted without a title is called by its address, which
            // is what Trello itself shows for it.
            name: if raw.name.trim().is_empty() {
                raw.url.clone()
            } else {
                raw.name
            },
            id: raw.id,
            mime: raw.mime_type.filter(|m| !m.trim().is_empty()),
            bytes: raw.bytes,
            url: raw.url,
            upload: raw.is_upload,
        }
    }
}

/// A label as search answers it.
#[derive(Deserialize)]
struct Tag {
    #[serde(default)]
    name: String,
    /// A colour name, not a hex. `null` for a label with no colour.
    color: Option<String>,
}

/// A member of a card, as much of them as a row draws.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Member {
    username: String,
    avatar_url: Option<String>,
}

/// The column a card sits in, which is all of the list a card needs.
#[derive(Deserialize)]
struct ListName {
    name: String,
}

impl From<Card> for Task {
    fn from(card: Card) -> Self {
        Task {
            id: format!("trello:{}", card.short_link),
            source: "trello".into(),
            key: card.short_link,
            title: card.name,
            body: Some(card.desc).filter(|d| !d.is_empty()),
            url: card.short_url,
            state: if card.closed {
                TaskState::Closed
            } else {
                TaskState::Open
            },
            kind: TaskKind::Ticket,
            assignees: card
                .members
                .into_iter()
                .map(|who| Person {
                    login: who.username,
                    avatar: who.avatar_url,
                })
                .collect(),
            // A label can have a colour and no name; it then says its colour,
            // which is all a person sees on Trello's own board. One with
            // neither has nothing to show.
            labels: card
                .labels
                .into_iter()
                .filter_map(|tag| {
                    let name = if tag.name.is_empty() {
                        tag.color.clone()?
                    } else {
                        tag.name
                    };
                    Some(Label {
                        name,
                        colour: tag.color.as_deref().and_then(colour_of).map(String::from),
                    })
                })
                .collect(),
            updated_at: card.date_last_activity,
            // Trello does not know where the work happens, so the workspace
            // form asks.
            repo: None,
            status: card.list.map(|l| l.name),
            // Asked for separately, and only by `one`.
            attachments: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    use crate::tasks::{Query, TaskKind, TaskState};

    fn query_of(ask: &Query, board: Option<&str>) -> String {
        search_params(ask, board)
            .into_iter()
            .find(|(k, _)| *k == "query")
            .map(|(_, v)| v)
            .unwrap()
    }

    #[test]
    fn a_column_is_asked_by_name_and_quoted() {
        let q = query_of(
            &Query {
                status: Some("To do".into()),
                ..Default::default()
            },
            None,
        );
        assert!(q.contains(r#"list:"To do""#), "{q}");
    }

    #[test]
    fn a_typed_list_wins_over_the_column_beside_it() {
        let q = query_of(
            &Query {
                status: Some("To do".into()),
                raw: Some("list:Doing".into()),
                ..Default::default()
            },
            None,
        );
        assert!(q.contains("list:Doing"), "{q}");
        assert!(!q.contains("To do"), "{q}");
    }

    #[test]
    fn columns_come_back_in_the_boards_own_order() {
        let lists: Vec<List> = serde_json::from_value(json!([
            { "id": "c", "name": "Done", "pos": 3 },
            { "id": "a", "name": "To do", "pos": 1.5 },
            { "id": "b", "name": "Doing", "pos": 2 }
        ]))
        .unwrap();
        let labels: Vec<String> = in_board_order(lists).into_iter().map(|c| c.name).collect();
        assert_eq!(labels, vec!["To do", "Doing", "Done"]);
    }

    #[test]
    fn a_card_url_with_a_slug_still_names_its_card() {
        for url in [
            "https://trello.com/c/aB3dE9fG/42-fix-export",
            "https://trello.com/c/aB3dE9fG/42-fix-export/",
            "https://trello.com/c/aB3dE9fG/42-fix-export?filter=x",
            "https://trello.com/c/aB3dE9fG#comment-1",
            "https://trello.com/c/aB3dE9fG",
            "https://www.trello.com/c/aB3dE9fG/42-fix-export",
            "trello.com/c/aB3dE9fG/x",
        ] {
            assert_eq!(card_of(url), Some("aB3dE9fG"), "{url}");
        }
    }

    #[test]
    fn only_letters_and_digits_may_go_into_a_request_path() {
        assert!(is_short_link("aB3dE9fG"));
        assert!(!is_short_link(""));
        assert!(!is_short_link("../members/me"));
        assert!(!is_short_link("a/b"));
        assert!(!is_short_link("a?b"));
    }

    #[test]
    fn a_pasted_token_is_taken_whatever_it_came_wrapped_in() {
        assert_eq!(token_in("  abc123  "), "abc123");
        assert_eq!(token_in("token=abc123"), "abc123");
        assert_eq!(token_in("#token=abc123"), "abc123");
        assert_eq!(
            token_in("https://example.com/cb#token=abc123&x=1"),
            "abc123"
        );
        assert_eq!(token_in("?foo=1&token=abc123\n"), "abc123");
        assert_eq!(token_in(""), "");
    }

    #[test]
    fn a_board_is_keyed_by_the_id_search_and_its_lists_take() {
        let raw: Vec<RawBoard> = serde_json::from_value(json!([
            { "id": "5f1b2c3d4e5f6a7b8c9d0e1f", "name": "Zeta" },
            { "id": "60a1b2c3d4e5f6a7b8c9d0e1", "name": "alpha" }
        ]))
        .unwrap();
        let boards = in_name_order(raw);
        assert_eq!(boards[0].name, "alpha");
        assert_eq!(boards[0].key, "60a1b2c3d4e5f6a7b8c9d0e1");
        assert_eq!(boards[1].key, "5f1b2c3d4e5f6a7b8c9d0e1f");
    }

    #[test]
    fn only_a_board_id_may_go_into_a_board_path() {
        assert!(is_board_id("5f1b2c3d4e5f6a7b8c9d0e1f"));
        assert!(!is_board_id(""));
        assert!(!is_board_id("aB3dE9fG"));
        assert!(!is_board_id("5f1b2c3d4e5f6a7b8c9d0e1F"));
        assert!(!is_board_id("../members/me/aaaaaaaaaaaa"));
        assert!(!is_board_id("5f1b2c3d4e5f6a7b8c9d0e1f/x"));
    }

    #[test]
    fn a_board_url_or_another_host_is_not_a_card() {
        assert_eq!(card_of("https://trello.com/b/xYz/board"), None);
        assert_eq!(card_of("https://example.com/c/aB3dE9fG"), None);
        assert_eq!(card_of("https://trello.com.evil.io/c/aB3dE9fG"), None);
        assert_eq!(card_of("https://trello.com/c/"), None);
        assert_eq!(card_of("evil.io/?u=https://trello.com/c/aB3dE9fG"), None);
        assert_eq!(card_of("ftp://trello.com/c/aB3dE9fG"), None);
        assert_eq!(card_of(""), None);
    }

    #[test]
    fn what_somebody_typed_wins_over_the_chip_beside_it() {
        let q = query_of(
            &Query {
                state: Some(TaskState::Open),
                raw: Some("is:archived list:Doing".into()),
                ..Default::default()
            },
            None,
        );
        assert!(q.contains("is:archived"), "{q}");
        assert!(q.contains("list:Doing"), "{q}");
        assert!(!q.contains("is:open"), "{q}");
    }

    #[test]
    fn the_chips_alone_become_qualifiers() {
        let open = query_of(
            &Query {
                state: Some(TaskState::Open),
                ..Default::default()
            },
            None,
        );
        assert!(open.contains("is:open"), "{open}");
        let closed = query_of(
            &Query {
                state: Some(TaskState::Closed),
                ..Default::default()
            },
            None,
        );
        assert!(closed.contains("is:archived"), "{closed}");
    }

    #[test]
    fn asking_for_nothing_in_particular_still_sends_a_query() {
        assert_eq!(query_of(&Query::default(), None), "is:open");
        assert_eq!(
            query_of(
                &Query {
                    raw: Some("   ".into()),
                    page: 1,
                    ..Default::default()
                },
                Some("5f1b2c3d4e5f6a7b8c9d0e1f")
            ),
            "is:open"
        );
    }

    #[test]
    fn a_label_colour_is_the_shade_trello_draws_it_in() {
        assert_eq!(colour_of("green"), Some("4bce97"));
        assert_eq!(colour_of("blue_dark"), Some("0c66e4"));
        assert_eq!(colour_of("pink_light"), Some("fdd0ec"));
    }

    #[test]
    fn assigned_to_me_is_trellos_own_at_me() {
        let q = query_of(
            &Query {
                mine: true,
                ..Default::default()
            },
            None,
        );
        assert!(q.contains("@me"), "{q}");
    }

    #[test]
    fn a_typed_member_replaces_assigned_to_me() {
        let q = query_of(
            &Query {
                mine: true,
                raw: Some("member:ada".into()),
                ..Default::default()
            },
            None,
        );
        assert!(q.contains("@ada"), "{q}");
        assert!(!q.contains("@me"), "{q}");
    }

    #[test]
    fn quoted_values_keep_their_spaces_and_the_rest_is_text() {
        let typed = Typed::read(r#"export list:"In progress" label:"Needs QA" label:bug crash"#);
        assert_eq!(typed.list.as_deref(), Some("In progress"));
        assert_eq!(typed.labels, vec!["Needs QA", "bug"]);
        assert_eq!(typed.text, vec!["export", "crash"]);

        let q = query_of(
            &Query {
                raw: Some(r#"list:"In progress" crash"#.into()),
                ..Default::default()
            },
            None,
        );
        assert!(q.contains(r#"list:"In progress""#), "{q}");
        assert!(q.contains("crash"), "{q}");
    }

    #[test]
    fn a_picked_board_is_asked_by_id_and_the_page_counts_from_zero() {
        let params = search_params(
            &Query {
                page: 2,
                ..Default::default()
            },
            Some("5f1b2c3d4e5f6a7b8c9d0e1f"),
        );
        assert!(params.contains(&("idBoards", "5f1b2c3d4e5f6a7b8c9d0e1f".to_string())));
        assert!(params.contains(&("cards_page", "1".to_string())));
        assert!(params.contains(&("cards_limit", "30".to_string())));
        assert!(params.contains(&("modelTypes", "cards".to_string())));
        assert!(params.contains(&("card_list", "true".to_string())));
    }

    #[test]
    fn a_column_with_nothing_typed_is_the_whole_list() {
        let ask = Query {
            status: Some("5f1b2c3d4e5f6a7b8c9d0e1f".into()),
            ..Default::default()
        };
        assert_eq!(way_of(&ask), Way::WholeList);
        let blank = Query {
            raw: Some("   ".into()),
            ..ask
        };
        assert_eq!(way_of(&blank), Way::WholeList);
    }

    #[test]
    fn typing_or_assigned_to_me_turns_a_column_into_a_search() {
        let typed = Query {
            status: Some("5f1b2c3d4e5f6a7b8c9d0e1f".into()),
            raw: Some("export".into()),
            ..Default::default()
        };
        assert_eq!(way_of(&typed), Way::Search);
        let mine = Query {
            status: Some("5f1b2c3d4e5f6a7b8c9d0e1f".into()),
            mine: true,
            ..Default::default()
        };
        assert_eq!(way_of(&mine), Way::Search);
    }

    #[test]
    fn no_column_is_a_plain_search() {
        assert_eq!(way_of(&Query::default()), Way::Search);
    }

    #[test]
    fn a_list_is_asked_open_or_archived_by_the_state_chip() {
        let open = list_params(&Query::default());
        assert!(open.contains(&("filter", "open".to_string())));
        assert!(open.contains(&("members", "true".to_string())));
        assert!(open.contains(&("member_fields", "username,avatarUrl".to_string())));
        let closed = list_params(&Query {
            state: Some(TaskState::Closed),
            ..Default::default()
        });
        assert!(closed.contains(&("filter", "closed".to_string())));
    }

    #[test]
    fn a_malformed_column_key_is_refused_before_any_request() {
        let ask = Query {
            status: Some("../members/me".into()),
            ..Default::default()
        };
        let err = column_of(&ask).unwrap_err().to_string();
        assert!(err.contains("not a Trello list"), "{err}");
        assert_eq!(column_of(&Query::default()).unwrap(), None);
    }

    #[test]
    fn only_a_list_id_may_go_into_a_list_path() {
        assert!(is_board_id("5f1b2c3d4e5f6a7b8c9d0e1f"));
        assert!(column_of(&Query {
            status: Some("5f1b2c3d4e5f6a7b8c9d0e1f".into()),
            ..Default::default()
        })
        .unwrap()
        .is_some());
    }

    #[test]
    fn a_search_keeps_only_the_cards_of_the_exact_list() {
        let card = |link: &str, list: &str| {
            let mut c = full_card();
            c["shortLink"] = json!(link);
            c["idList"] = json!(list);
            serde_json::from_value::<Card>(c).unwrap()
        };
        // Trello's `list:"Urgent"` also matched the cards of "Non urgent".
        let found = vec![
            card("aaaaaaaa", "urgent"),
            card("bbbbbbbb", "non-urgent"),
            card("cccccccc", "urgent"),
        ];
        let kept: Vec<String> = in_list(found, "urgent")
            .into_iter()
            .map(|c| c.short_link)
            .collect();
        assert_eq!(kept, vec!["aaaaaaaa", "cccccccc"]);
    }

    #[test]
    fn a_lists_cards_take_the_lists_name_and_keep_trellos_order() {
        let cards: Vec<Card> = serde_json::from_value(json!([
            {
                "shortLink": "bbbbbbbb", "name": "Second", "shortUrl": "https://trello.com/c/bbbbbbbb",
                "dateLastActivity": "2026-11-01T10:00:00.000Z", "idList": "l1"
            },
            {
                "shortLink": "aaaaaaaa", "name": "First", "shortUrl": "https://trello.com/c/aaaaaaaa",
                "dateLastActivity": "2026-11-02T10:00:00.000Z", "idList": "l1"
            }
        ]))
        .unwrap();
        let tasks = in_column(cards, "Urgent");
        let seen: Vec<(&str, Option<&str>)> = tasks
            .iter()
            .map(|t| (t.title.as_str(), t.status.as_deref()))
            .collect();
        assert_eq!(
            seen,
            vec![("Second", Some("Urgent")), ("First", Some("Urgent"))]
        );
    }

    #[test]
    fn the_first_page_and_no_board_ask_for_page_zero_everywhere() {
        let params = search_params(&Query::default(), None);
        assert!(params.contains(&("cards_page", "0".to_string())));
        assert!(!params.iter().any(|(k, _)| *k == "idBoards"));
    }

    fn full_card() -> serde_json::Value {
        json!({
            "shortLink": "aB3dE9fG",
            "name": "Fix export",
            "desc": "It drops rows.",
            "shortUrl": "https://trello.com/c/aB3dE9fG",
            "closed": false,
            "dateLastActivity": "2026-11-01T10:00:00.000Z",
            "labels": [
                { "name": "Bug", "color": "red" },
                { "name": "Soon", "color": "green" }
            ],
            "members": [
                { "username": "ada", "avatarUrl": "https://trello-members.s3.amazonaws.com/x" }
            ],
            "list": { "name": "Doing" }
        })
    }

    #[test]
    fn a_card_becomes_a_task_with_its_column() {
        let card: Card = serde_json::from_value(full_card()).unwrap();
        let task = Task::from(card);

        assert_eq!(task.id, "trello:aB3dE9fG");
        assert_eq!(task.source, "trello");
        assert_eq!(task.key, "aB3dE9fG");
        assert_eq!(task.title, "Fix export");
        assert_eq!(task.body.as_deref(), Some("It drops rows."));
        assert_eq!(task.url, "https://trello.com/c/aB3dE9fG");
        assert_eq!(task.state, TaskState::Open);
        assert_eq!(task.kind, TaskKind::Ticket);
        assert_eq!(task.repo, None);
        assert_eq!(task.status.as_deref(), Some("Doing"));
        assert_eq!(task.assignees.len(), 1);
        assert_eq!(task.assignees[0].login, "ada");
        assert!(task.assignees[0].avatar.is_some());
        assert_eq!(task.labels[1].name, "Soon");
        assert_eq!(task.labels[1].colour.as_deref(), colour_of("green"));
        assert_eq!(task.labels[1].colour.as_deref(), Some("4bce97"));
        assert_eq!(task.updated_at.to_rfc3339(), "2026-11-01T10:00:00+00:00");
    }

    #[test]
    fn an_archived_card_is_closed() {
        let mut json = full_card();
        json["closed"] = json!(true);
        let task = Task::from(serde_json::from_value::<Card>(json).unwrap());
        assert_eq!(task.state, TaskState::Closed);
    }

    #[test]
    fn a_label_without_a_name_says_its_colour_and_an_unknown_colour_is_dropped() {
        let mut json = full_card();
        json["labels"] = json!([
            { "name": "", "color": "green" },
            { "name": "Later", "color": "chartreuse_neon" },
            { "name": "", "color": null }
        ]);
        let task = Task::from(serde_json::from_value::<Card>(json).unwrap());
        assert_eq!(task.labels.len(), 2);
        assert_eq!(task.labels[0].name, "green");
        assert_eq!(task.labels[0].colour.as_deref(), Some("4bce97"));
        assert_eq!(task.labels[1].name, "Later");
        assert_eq!(task.labels[1].colour, None);
    }

    #[test]
    fn an_empty_description_is_no_body() {
        let mut json = full_card();
        json["desc"] = json!("");
        let task = Task::from(serde_json::from_value::<Card>(json).unwrap());
        assert_eq!(task.body, None);
    }

    #[test]
    fn a_card_with_no_list_has_no_status() {
        let mut json = full_card();
        json.as_object_mut().unwrap().remove("list");
        let task = Task::from(serde_json::from_value::<Card>(json).unwrap());
        assert_eq!(task.status, None);
    }

    #[test]
    fn every_colour_family_has_a_plain_dark_and_light_shade() {
        for family in [
            "green", "yellow", "orange", "red", "purple", "blue", "sky", "lime", "pink", "black",
        ] {
            for name in [
                family.to_string(),
                format!("{family}_dark"),
                format!("{family}_light"),
            ] {
                let hex = colour_of(&name).unwrap_or_else(|| panic!("{name}"));
                assert_eq!(hex.len(), 6);
                assert!(hex.chars().all(|c| c.is_ascii_hexdigit()), "{name}");
            }
        }
        assert_eq!(colour_of("chartreuse_neon"), None);
    }

    fn attachments_fixture() -> Vec<RawAttachment> {
        serde_json::from_value(json!([
            {
                "id": "5f1b2c3d4e5f60718293a4b5",
                "name": "screenshot.png",
                "mimeType": "image/png",
                "bytes": 150_000,
                "url": "https://trello.com/1/cards/5f1b2c3d4e5f60718293a4b0/attachments/5f1b2c3d4e5f60718293a4b5/download/screenshot.png",
                "isUpload": true
            },
            {
                "id": "5f1b2c3d4e5f60718293a4b6",
                "name": "spec.pdf",
                "url": "https://trello.com/1/cards/5f1b2c3d4e5f60718293a4b0/attachments/5f1b2c3d4e5f60718293a4b6/download/spec.pdf",
                "isUpload": true
            },
            {
                "id": "5f1b2c3d4e5f60718293a4b7",
                "name": "",
                "mimeType": "",
                "bytes": null,
                "url": "https://www.figma.com/file/abc/Checkout",
                "isUpload": false
            }
        ]))
        .unwrap()
    }

    #[test]
    fn a_cards_attachments_say_which_are_files_and_which_are_links() {
        let list: Vec<TaskAttachment> = attachments_fixture().into_iter().map(Into::into).collect();

        assert_eq!(list[0].name, "screenshot.png");
        assert_eq!(list[0].mime.as_deref(), Some("image/png"));
        assert_eq!(list[0].bytes, Some(150_000));
        assert!(list[0].upload);

        // Trello left the type and the size off: unknown, not zero.
        assert_eq!(list[1].mime, None);
        assert_eq!(list[1].bytes, None);
        assert!(list[1].upload);

        // A link with no name is called by its address, and an empty type is
        // no type.
        assert!(!list[2].upload);
        assert_eq!(list[2].mime, None);
        assert_eq!(list[2].name, "https://www.figma.com/file/abc/Checkout");
    }

    #[test]
    fn only_an_attachment_on_this_card_is_served() {
        let list: Vec<TaskAttachment> = attachments_fixture().into_iter().map(Into::into).collect();
        assert_eq!(
            served(&list, "5f1b2c3d4e5f60718293a4b5").map(|a| a.name.as_str()),
            Ok("screenshot.png")
        );
        assert_eq!(
            served(&list, "000000000000000000000000").err(),
            Some(Unserved::NotOnCard)
        );
    }

    #[test]
    fn a_link_has_no_bytes_to_serve() {
        let list: Vec<TaskAttachment> = attachments_fixture().into_iter().map(Into::into).collect();
        assert_eq!(
            served(&list, "5f1b2c3d4e5f60718293a4b7").err(),
            Some(Unserved::NotAFile)
        );
    }

    #[test]
    fn a_file_over_the_cap_is_refused_before_it_is_downloaded() {
        let mut list: Vec<TaskAttachment> =
            attachments_fixture().into_iter().map(Into::into).collect();
        list[0].bytes = Some(BIGGEST_ATTACHMENT + 1);
        assert_eq!(
            served(&list, "5f1b2c3d4e5f60718293a4b5").err(),
            Some(Unserved::TooBig)
        );
        list[0].bytes = Some(BIGGEST_ATTACHMENT);
        assert!(served(&list, "5f1b2c3d4e5f60718293a4b5").is_ok());
        // An unknown size is decided while reading, against the same cap.
        assert!(served(&list, "5f1b2c3d4e5f60718293a4b6").is_ok());
        assert!(fits(BIGGEST_ATTACHMENT));
        assert!(!fits(BIGGEST_ATTACHMENT + 1));
    }

    #[test]
    fn the_cap_is_the_desktops_biggest_file() {
        assert_eq!(BIGGEST_ATTACHMENT, 25 * 1024 * 1024);
    }

    #[test]
    fn only_an_attachment_id_may_go_into_a_request_path() {
        assert!(is_attachment_id("5f1b2c3d4e5f60718293a4b5"));
        assert!(!is_attachment_id("../../members/me"));
        assert!(!is_attachment_id("6ace083d5588abbdfabc955"));
        assert!(!is_attachment_id(""));
    }

    #[test]
    fn a_files_name_is_made_safe_for_the_download_path() {
        assert_eq!(file_segment("my screen shot.png"), "my_screen_shot.png");
        assert_eq!(file_segment("../../etc/passwd"), "etc_passwd");
        assert_eq!(file_segment("a?b#c/d"), "a_b_c_d");
        assert_eq!(file_segment(""), "file");
        assert_eq!(file_segment("..."), "file");
    }

    #[test]
    fn a_board_link_is_not_a_card_to_bring_attachments_from() {
        assert_eq!(
            card_in("https://trello.com/b/aB3dE9fG/roadmap"),
            Err(Unserved::NotACard)
        );
        assert_eq!(
            card_in("https://trello.com/c/../x"),
            Err(Unserved::NotACard)
        );
        assert_eq!(
            card_in("https://trello.com/c/aB3dE9fG/42-fix"),
            Ok("aB3dE9fG")
        );
    }

    /// Chunks as a download would hand them over, one at a time.
    fn chunks(sizes: &[usize]) -> impl futures::Stream<Item = Result<Vec<u8>>> {
        let all: Vec<Result<Vec<u8>>> = sizes.iter().map(|n| Ok(vec![7u8; *n])).collect();
        futures::stream::iter(all)
    }

    fn too_big(r: Result<Vec<u8>>) -> bool {
        r.err().and_then(|e| e.downcast_ref::<Unserved>().copied()) == Some(Unserved::TooBig)
    }

    #[tokio::test]
    async fn a_download_declared_over_the_cap_is_refused_before_a_byte_is_read() {
        assert!(too_big(read_capped(Some(11), 10, chunks(&[1])).await));
    }

    #[tokio::test]
    async fn a_download_that_runs_past_the_cap_is_cut_off_whatever_it_declared() {
        assert!(too_big(read_capped(None, 10, chunks(&[6, 6])).await));
        assert!(too_big(read_capped(Some(4), 10, chunks(&[6, 6])).await));
    }

    #[tokio::test]
    async fn a_download_exactly_at_the_cap_arrives_whole() {
        let got = read_capped(Some(10), 10, chunks(&[5, 5])).await.unwrap();
        assert_eq!(got.len(), 10);
    }
}
