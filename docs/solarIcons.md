# React (/docs/v2/packages/react)



<CodeBlockTabs defaultValue="npm" groupId="package-manager">
  <CodeBlockTabsList>
    <CodeBlockTabsTrigger value="npm">
      npm
    </CodeBlockTabsTrigger>

    <CodeBlockTabsTrigger value="pnpm">
      pnpm
    </CodeBlockTabsTrigger>

    <CodeBlockTabsTrigger value="yarn">
      yarn
    </CodeBlockTabsTrigger>

    <CodeBlockTabsTrigger value="bun">
      bun
    </CodeBlockTabsTrigger>
  </CodeBlockTabsList>

  <CodeBlockTab value="npm">
    ```bash
    npm install @solar-icons/react@2.0.0-beta.0
    ```
  </CodeBlockTab>

  <CodeBlockTab value="pnpm">
    ```bash
    pnpm add @solar-icons/react@2.0.0-beta.0
    ```
  </CodeBlockTab>

  <CodeBlockTab value="yarn">
    ```bash
    yarn add @solar-icons/react@2.0.0-beta.0
    ```
  </CodeBlockTab>

  <CodeBlockTab value="bun">
    ```bash
    bun add @solar-icons/react@2.0.0-beta.0
    ```
  </CodeBlockTab>
</CodeBlockTabs>

## Import patterns [#import-patterns]

```jsx
// Per-style (no style suffix in name - style is in the path)
import { HeartIcon } from '@solar-icons/react/bold'

// Single icon (lighter on the dev server — avoids resolving ~8k modules)
import { HeartIcon } from '@solar-icons/react/bold/heart'

// Top-level (style suffix in name - path doesn't specify style)
import { HeartBoldIcon } from '@solar-icons/react'

// Dynamic (runtime style switching)
import { HeartIcon } from '@solar-icons/react/dynamic'
import { HeartIcon } from '@solar-icons/react/dynamic/heart'
```

## Basic usage [#basic-usage]

```jsx
import { HeartIcon } from '@solar-icons/react/bold'

function App() {
    return <HeartIcon color="#ef4444" size={32} />
}
```

## Duotone [#duotone]

BoldDuotone and LineDuotone styles render a secondary accent path. Control it with `secondaryColor` and `secondaryOpacity`.

```jsx
import { HeartIcon } from '@solar-icons/react/bold-duotone'

function App() {
    return <HeartIcon color="#3b82f6" secondaryColor="#f59e0b" secondaryOpacity={0.4} size={48} />
}
```

## Stroke width [#stroke-width]

Linear, Broken, and LineDuotone icons accept `strokeWidth`. Default is `1.5`.

```jsx
import { SettingsIcon } from '@solar-icons/react/linear'

function App() {
    return <SettingsIcon strokeWidth={2} size={24} />
}
```

## SolarProvider [#solarprovider]

Wrap your app in `SolarProvider` to set defaults. Icons inherit through the CSS cascade without re-rendering.

```jsx
import { SolarProvider } from '@solar-icons/react'
import { HeartIcon } from '@solar-icons/react/bold'

function App() {
    return (
        <SolarProvider color="#3b82f6" size={24} strokeWidth={1.5}>
            <HeartIcon />
        </SolarProvider>
    )
}
```

The provider sets CSS custom properties on a `<div>` with `display: contents`. Changing a value updates the wrapper only. Icons do not re-render.

### Provider props [#provider-props]

| Prop               | CSS Variable                | Fallback       |
| ------------------ | --------------------------- | -------------- |
| `color`            | `--solar-color`             | `currentColor` |
| `size`             | `--solar-size`              | `24px`         |
| `strokeWidth`      | `--solar-stroke-width`      | `1.5`          |
| `secondaryColor`   | `--solar-secondary-color`   | `currentColor` |
| `secondaryOpacity` | `--solar-secondary-opacity` | `0.5`          |

The provider does not set defaults. Icons fall back to these values through CSS when no provider or prop is specified.

## useSolar [#usesolar]

Access and change provider values from any descendant component. Must be called inside a `<SolarProvider>`.

```jsx
import { useSolar } from '@solar-icons/react'

function ColorToggle() {
    const { color, setColor } = useSolar()

    return <button onClick={() => setColor('#ef4444')}>Current: {color}</button>
}
```

## Icon props [#icon-props]

Every icon accepts these props plus standard SVG attributes (`ref`, `className`, `style`, etc.).

| Prop               | Type               | Description                                           |
| ------------------ | ------------------ | ----------------------------------------------------- |
| `color`            | `string`           | Icon color. Overrides provider.                       |
| `size`             | `string \| number` | Width and height. Numbers become `{n}px`.             |
| `strokeWidth`      | `string \| number` | Stroke width for Linear/Broken/LineDuotone.           |
| `secondaryColor`   | `string`           | Duotone accent color.                                 |
| `secondaryOpacity` | `number`           | Duotone accent opacity (0–1).                         |
| `isolated`         | `boolean`          | Ignores provider. Uses `24px`, `currentColor`, `1.5`. |
| `alt`              | `string`           | Accessibility label. Renders `<title>` in SVG.        |

## Dynamic icons [#dynamic-icons]

```jsx
import { HeartIcon } from '@solar-icons/react/dynamic'

function App() {
    return <HeartIcon weight="BoldDuotone" color="#3b82f6" size={32} />
}
```

The `weight` prop accepts `'Bold' | 'Linear' | 'Outline' | 'BoldDuotone' | 'LineDuotone' | 'Broken'`.

## CSS variables [#css-variables]

Icons resolve styling through CSS custom properties.

| Variable                    | Role                                       |
| --------------------------- | ------------------------------------------ |
| `--solar-color`             | Fill and stroke color                      |
| `--solar-size`              | Width and height                           |
| `--solar-stroke-width`      | Stroke width for Linear/Broken/LineDuotone |
| `--solar-secondary-color`   | Secondary color for duotone styles         |
| `--solar-secondary-opacity` | Secondary opacity for duotone styles       |

## CSS classes [#css-classes]

Every icon renders with two classes:

| Class                  | Description                                                |
| ---------------------- | ---------------------------------------------------------- |
| `solar`                | Present on every icon. Use for global styling.             |
| `solar-{name}-{style}` | Specific to the icon and style (e.g., `solar-heart-bold`). |

```css
.solar {
    vertical-align: middle;
}
.solar-heart-bold {
    color: #ef4444;
}
```

## ESM only [#esm-only]

`@solar-icons/react` is ESM-only. `require()` does not work. Use `import` syntax or `await import()`. All V2 packages follow this convention.
