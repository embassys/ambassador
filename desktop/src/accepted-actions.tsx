import { useRef, useState } from "react";
import type { CentralActionType, CentralAvailableActions } from "../../src/central-rest.js";
import type { DesktopCommand } from "../../src/desktop/protocol.js";
import { DetailSheet } from "./details.js";

interface Data {
  agent_id: string;
  state: "ready";
  policy: CentralAvailableActions;
  catalog: CentralActionType[];
}

export function AcceptedActions({
  instanceId,
  command,
}: {
  instanceId: string;
  command(input: DesktopCommand): Promise<unknown>;
}) {
  const [data, setData] = useState<Data>();
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [reviewedOnly, setReviewedOnly] = useState(false);
  const [address, setAddress] = useState("");
  const [peer, setPeer] = useState(false);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const generation = useRef(0);
  async function load(target?: string) {
    const current = ++generation.current;
    setBusy(true);
    setNotice("");
    setData(undefined);
    setPeer(target !== undefined);
    try {
      const result = (await command({
        type: "accepted_actions",
        instanceId,
        ...(target ? { agent_email: target } : {}),
      })) as Data;
      if (current !== generation.current) return;
      if (result.state !== "ready") throw new Error();
      setData(result);
      setSelected(result.policy.available_actions ?? []);
      setUncertain(false);
      setFilter("");
      setCustom("");
    } catch {
      if (current === generation.current)
        setNotice(
          "Couldn’t load accepted requests. Check that this agent is registered and running, then try again.",
        );
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  async function save() {
    if (!data || peer || uncertain || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const policy = (await command({
        type: "set_accepted_actions",
        instanceId,
        agent_id: data.agent_id,
        available_actions: selected,
      })) as CentralAvailableActions;
      if (!policy.restricted || !Array.isArray(policy.available_actions)) throw new Error();
      setData({ ...data, policy });
      setSelected(policy.available_actions);
      setNotice("Accepted requests saved. Existing permissions are unchanged.");
    } catch {
      setUncertain(true);
      setNotice(
        "The save could not be confirmed. Refresh to read the current list before making another change.",
      );
    } finally {
      setBusy(false);
    }
  }
  const names = [
    ...new Set([
      ...(data?.catalog.map((item) => item.name) ?? []),
      ...selected,
      ...(data?.policy.available_actions ?? []),
    ]),
  ];
  const shown = names.filter(
    (name) =>
      name.includes(filter.trim().toLowerCase()) &&
      (!reviewedOnly || data?.catalog.some((item) => item.name === name && item.verified === true)),
  );
  const changed =
    data &&
    (data.policy.available_actions === null ||
      JSON.stringify(selected) !== JSON.stringify(data.policy.available_actions));
  return (
    <DetailSheet
      title="Accepted requests"
      meta="Choose what people can ask your agent for"
      onOpen={() => void load()}
    >
      <p className="body-note">
        Choose which new permission requests reach you. You still approve access separately.
        Existing grants stay active until you revoke them.
      </p>
      <form
        className="accepted-lookup"
        onSubmit={(event) => {
          event.preventDefault();
          if (address.trim()) void load(address.trim());
        }}
      >
        <label>
          Check another agent
          <input
            placeholder="Email or username"
            value={address}
            maxLength={254}
            disabled={busy}
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
        <button type="submit" className="secondary" disabled={busy || !address.trim()}>
          Look up
        </button>
      </form>
      <div className="button-row">
        {peer && (
          <button type="button" className="secondary" disabled={busy} onClick={() => void load()}>
            My agent
          </button>
        )}
        <button
          type="button"
          className="quiet-button"
          disabled={busy}
          onClick={() => void load(peer ? address.trim() : undefined)}
        >
          Refresh
        </button>
      </div>
      {busy && <p role="status">Updating…</p>}
      {notice && (
        <p className="body-note" role="status">
          {notice}
        </p>
      )}
      {data && (
        <>
          <div className="accepted-summary">
            <strong>{peer ? data.policy.agent_email : "Your agent"}</strong>
            <p>
              {data.policy.available_actions === null
                ? "No restriction declared — any action can be requested."
                : data.policy.available_actions.length === 0
                  ? "No new permission requests accepted."
                  : `${data.policy.available_actions.length} request types accepted.`}
            </p>
          </div>
          <label>
            Find an action
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <div className="accepted-list">
            <label className="accepted-choice">
              <input
                type="checkbox"
                checked={reviewedOnly}
                onChange={(event) => setReviewedOnly(event.target.checked)}
              />
              <span>Show reviewed actions only</span>
            </label>
            {shown.slice(0, 100).map((name) => {
              const item = data.catalog.find((entry) => entry.name === name);
              const checked = peer && !data.policy.restricted ? true : selected.includes(name);
              return (
                <label className="accepted-choice" key={name}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={peer || busy || uncertain}
                    onChange={(event) =>
                      setSelected((values) =>
                        event.target.checked
                          ? [...values, name]
                          : values.filter((value) => value !== name),
                      )
                    }
                  />
                  <span>
                    <strong>{name.replaceAll("_", " ")}</strong>
                    <small>{item?.description || "Custom action"}</small>
                  </span>
                  <span className="subtle-tag">{item?.verified ? "Reviewed" : "Unreviewed"}</span>
                </label>
              );
            })}
          </div>
          {shown.length > 100 && (
            <p className="body-note">Showing 100 matches. Refine your search to find more.</p>
          )}
          {!peer && (
            <>
              <form
                className="accepted-lookup"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = custom.trim().toLowerCase();
                  if (value && !selected.includes(value) && selected.length < 500)
                    setSelected([...selected, value]);
                  setCustom("");
                }}
              >
                <label>
                  Custom action
                  <input
                    value={custom}
                    maxLength={128}
                    disabled={busy || uncertain}
                    onChange={(event) => setCustom(event.target.value)}
                  />
                </label>
                <button
                  type="submit"
                  className="secondary"
                  disabled={busy || uncertain || !custom.trim() || selected.length >= 500}
                >
                  Add
                </button>
              </form>
              <p className="body-note">
                New names become public, unreviewed catalog entries. An unreviewed action may have
                no defined input or result schema.
              </p>
              <div className="accepted-footer">
                <span>
                  {selected.length
                    ? `${selected.length} selected`
                    : "Saving will stop all new permission requests"}
                </span>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || uncertain || !changed || selected.length > 500}
                  onClick={() => void save()}
                >
                  Save list
                </button>
              </div>
            </>
          )}
        </>
      )}
    </DetailSheet>
  );
}
