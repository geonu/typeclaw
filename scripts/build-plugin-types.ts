#!/usr/bin/env bun

import { rm } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as ts from '@typescript/typescript6'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = join(root, 'src')
const outputRoot = join(root, 'dist', 'types')
const configPath = join(root, 'tsconfig.json')
const config = ts.readConfigFile(configPath, ts.sys.readFile)
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
const options: ts.CompilerOptions = {
  ...parsed.options,
  noEmit: false,
  noEmitOnError: true,
  declaration: true,
  declarationMap: false,
  emitDeclarationOnly: true,
  rootDir: sourceRoot,
  outDir: outputRoot,
}
const program = ts.createProgram([join(sourceRoot, 'plugin', 'index.ts')], options)
const resolutionCache = ts.createModuleResolutionCache(root, (path) => path, options)

// Keep the emitted graph self-contained: consumers must not inherit our @/*
// aliases. Explicit .js specifiers also work with NodeNext declaration lookup.
const rewriteImports: ts.TransformerFactory<ts.SourceFile | ts.Bundle> = (context) => {
  return (source) => {
    if (ts.isBundle(source)) return source
    const rewrite = (specifier: ts.StringLiteral): ts.StringLiteral => {
      if (!specifier.text.startsWith('@/') && !specifier.text.startsWith('.')) return specifier
      const resolved = ts.resolveModuleName(
        specifier.text,
        source.fileName,
        options,
        ts.sys,
        resolutionCache,
      ).resolvedModule
      if (!resolved) throw new Error(`Cannot resolve SDK declaration import ${specifier.text} in ${source.fileName}`)
      let path = relative(dirname(source.fileName), resolved.resolvedFileName).replaceAll('\\', '/')
      path = path
        .replace(/\.tsx?$/, '.js')
        .replace(/\.mts$/, '.mjs')
        .replace(/\.cts$/, '.cjs')
      return context.factory.createStringLiteral(path.startsWith('.') ? path : `./${path}`)
    }
    const visit: ts.Visitor = (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
        return context.factory.updateImportDeclaration(
          node,
          node.modifiers,
          node.importClause,
          rewrite(node.moduleSpecifier),
          node.attributes,
        )
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        return context.factory.updateExportDeclaration(
          node,
          node.modifiers,
          node.isTypeOnly,
          node.exportClause,
          rewrite(node.moduleSpecifier),
          node.attributes,
        )
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal))
        return context.factory.updateImportTypeNode(
          node,
          context.factory.createLiteralTypeNode(rewrite(node.argument.literal)),
          node.attributes,
          node.qualifier,
          node.typeArguments,
          node.isTypeOf,
        )
      return ts.visitEachChild(node, visit, context)
    }
    return ts.visitNode(source, visit) as ts.SourceFile
  }
}

const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
if (diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
  console.error(
    ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (path) => path,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    }),
  )
  process.exit(1)
}
await rm(outputRoot, { recursive: true, force: true })
const result = program.emit(undefined, undefined, undefined, true, { afterDeclarations: [rewriteImports] })
if (result.emitSkipped || result.diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error))
  throw new Error(
    ts.formatDiagnostics(result.diagnostics, {
      getCanonicalFileName: (path) => path,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    }),
  )
console.log('Built public plugin declarations under dist/types')
