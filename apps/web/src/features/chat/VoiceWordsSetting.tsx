/**
 * Chat settings → Voice notes: whether the server writes voice notes out with the business's OpenAI
 * key (apps/api/src/services/chatVoice.ts). Off until an owner or admin turns it on, and the key is
 * checked with OpenAI first, since each one is paid for on that key. Off, a voice note keeps the
 * words the phone heard as it was recorded, where the phone could.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { FormError } from "@/components/ui/Field";
import { Section } from "@/components/ui/Section";
import { SwitchRow } from "@/features/settings/SettingsKit";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";

export function VoiceWordsSetting() {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const key = ["chat-voice-words", company.id];
  const state = useQuery({ queryKey: key, queryFn: () => api.get<{ on: boolean; openai: boolean }>("/chat/settings/voice-words") });
  const save = useMutation({
    meta: { inline: true },
    mutationFn: (on: boolean) => api.put<{ on: boolean }>("/chat/settings/voice-words", { on }),
    onSuccess: (r) => queryClient.setQueryData(key, (old: { on: boolean; openai: boolean } | undefined) => ({ openai: old?.openai ?? true, on: r.on })),
  });
  if (!state.data) return null;
  return (
    <Section level={3} title="Voice notes">
      <div className="set-rows">
        <SwitchRow
          label="Write out voice notes with OpenAI"
          hint={
            <>
              Each voice note sent in Team chat is written out by OpenAI, and its words show under it for everyone in the channel. It uses your OpenAI key from{" "}
              <Link to="/apps/chatgpt">Apps → ChatGPT</Link>, which is checked before this turns on, and is paid for on that key.
              {!state.data.openai && " Add an OpenAI key there first."} Off, a voice note shows the words the phone heard as it was recorded, where the phone could.
            </>
          }
          checked={save.isPending ? Boolean(save.variables) : state.data.on}
          disabled={save.isPending || (!state.data.on && !state.data.openai)}
          onChange={(next) => save.mutate(next)}
        />
      </div>
      <FormError error={save.error} />
    </Section>
  );
}
