import { Predicate, type Schema } from "effect";

// The CLI's `capture` and `redact` replace through this table and `scan` finds through it,
// so what one would replace the other flags, and what one writes the other never flags.
interface Contact {
  readonly kind: string;
  readonly pattern: RegExp;
  readonly placeholder: string;
}

const contacts: ReadonlyArray<Contact> = [
  {
    kind: "an email address",
    // example.com is already a placeholder. The lookbehind keeps a long run with no `@`
    // from being rescanned from every character.
    pattern: /(?<![\w.+-])[\w.+-]+@(?!example\.com\b)[\w-]+(?:\.[\w-]+)+/g,
    placeholder: "contact@example.com",
  },
  {
    kind: "a phone number",
    // Whole string only, starting with `+` or a bracketed area code, so a date or id never matches.
    pattern: /^(?:\+\d[\d\s().-]{7,}\d|\(\d{3}\)\s?\d{3}-\d{4})$/g,
    placeholder: "+1 555 0100",
  },
  {
    kind: "a LinkedIn profile",
    pattern: /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[^\s/?"']+\/?/g,
    placeholder: "https://www.linkedin.com/in/example",
  },
];

// A placeholder matches its own pattern and replaces itself, so scrubbing text
// that is already scrubbed changes nothing.
export const scrubContact = (text: string) =>
  contacts.reduce((safe, { pattern, placeholder }) => safe.replace(pattern, placeholder), text);

export const contactIn = (text: string) =>
  contacts.flatMap(({ kind, pattern, placeholder }) =>
    text.replace(pattern, placeholder) === text ? [] : [kind],
  );

const credentialWord =
  /api[_-]?key|token|secret|passw(?:or)?d|passphrase|pwd|jwt|bearer|authorization|credential|signature|cookie|session|(?:^|[_-])key(?:[_-]id)?$/i;
// Case matters here: `privateKey` names a key, `monkey` does not.
const camelCaseKey = /[a-z0-9]Key(?:Id)?$/;

// The key alone decides, whatever the value looks like.
export const isCredentialKey = (key: string) => credentialWord.test(key) || camelCaseKey.test(key);

// Contact details are scrubbed from keys as well as values.
export const redact = (value: Schema.Json): Schema.Json => {
  if (Predicate.isString(value)) return scrubContact(value);
  if (Array.isArray(value)) return value.map(redact);
  if (!Predicate.isReadonlyObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, Schema.Json>>).map(([key, field]) => [
      scrubContact(key),
      isCredentialKey(key) ? "***" : redact(field),
    ]),
  );
};
