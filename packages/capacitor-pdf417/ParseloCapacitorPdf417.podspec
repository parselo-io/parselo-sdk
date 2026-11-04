require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  # NOTE: the filename and s.name must match the pod name Capacitor derives from
  # the npm package name. If `npx cap sync` / `pod install` can't find the pod,
  # reconcile this name (or let `npm init @capacitor/plugin` generate it exactly).
  s.name = 'ParseloCapacitorPdf417'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://github.com/parselo-io/parselo-sdk'
  s.author = 'Parselo'
  s.source = { :git => 'https://github.com/parselo-io/parselo-sdk.git', :tag => s.version.to_s }
  s.source_files = 'ios/**/*.{swift,h,m}'
  s.ios.deployment_target = '13.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.1'
end
