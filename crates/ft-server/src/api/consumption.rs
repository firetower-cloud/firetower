//! What the fleet spent, and on what.
//!
//! One endpoint rather than four, because the page is one slice: the headline,
//! the chart and the ledger all have to be the same period, the same scope and
//! the same access, and three requests that could disagree with each other is a
//! page that eventually does.
//!
//! Every read underneath is scoped by `filed_where`, so this answers in exactly
//! the terms the rest of the product does: an administrator is not a reader of
//! anything they were not granted.

use super::ApiResult;
use crate::auth::Principal;
use crate::db::{Bucket, Column, Dimension, Group, Slice, Totals};
use crate::AppState;
use axum::{
    extract::{Query, State},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

/// What to show, and how to cut it.
#[derive(Debug, Deserialize, IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub struct Ask {
    /// Inclusive.
    pub from: chrono::DateTime<chrono::Utc>,
    /// Exclusive, so a day boundary belongs to one bucket and not two.
    pub to: chrono::DateTime<chrono::Utc>,
    pub bucket: Bucket,
    pub group: Dimension,
    /// A second level, cut from each row of the first.
    ///
    /// Either order gives the same totals — it is one more `GROUP BY` column,
    /// not a different query — which is why the interface can offer to swap
    /// them.
    #[serde(default)]
    pub then: Option<Dimension>,
    /// Narrow to one person. `me` means whoever is asking.
    #[serde(default)]
    pub person: Option<String>,
    /// Narrow to whoever is in one team.
    #[serde(default)]
    pub team: Option<String>,
}

/// The whole page, in the terms the person asking may see it.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Consumption {
    pub totals: Totals,
    pub series: Vec<Column>,
    pub groups: Vec<Group>,
}

/// What was spent in a period.
#[utoipa::path(
    get, path = "/api/v1/consumption", tag = "consumption",
    params(Ask),
    responses((status = 200, body = Consumption)),
)]
pub(super) async fn consumption(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Query(ask): Query<Ask>,
) -> ApiResult<Json<Consumption>> {
    let me = principal.owner().unwrap_or_default().to_string();

    let slice = Slice {
        from: ask.from,
        to: ask.to,
        // `me` rather than an id, so a link somebody shares does not quietly
        // show them whoever sent it.
        person: match ask.person.as_deref() {
            Some("me") => Some(me.clone()),
            other => other.map(str::to_string),
        },
        team: ask.team.clone(),
    };

    let totals = state.db.consumption_totals(&me, &slice).await?;
    let series = state.db.consumption_series(&me, &slice, ask.bucket).await?;
    let mut groups = state.db.consumption_groups(&me, &slice, ask.group).await?;

    // The second level, cut from each row of the first. Only for the rows that
    // will be drawn: a hundred groups each fanning out again is a query nobody
    // asked for, and the interface folds everything past the ninth anyway.
    if let Some(then) = ask.then.filter(|t| *t != ask.group) {
        for group in groups.iter_mut().take(12) {
            let mut narrowed = Slice {
                from: slice.from,
                to: slice.to,
                person: slice.person.clone(),
                team: slice.team.clone(),
            };
            // Grouping by person and then by something else is the same as
            // asking for that person. Every other dimension needs its own
            // filter, which `consumption_groups` does not take — so for now
            // only person narrows, and the rest come back empty rather than
            // wrong.
            if ask.group == Dimension::Person {
                narrowed.person = group.key.clone();
                group.children = state.db.consumption_groups(&me, &narrowed, then).await?;
            }
        }
    }

    Ok(Json(Consumption {
        totals,
        series,
        groups,
    }))
}
