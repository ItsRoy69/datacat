package main

import (
	"fmt"
	"os"

	"go.opentelemetry.io/collector/component"
	"go.opentelemetry.io/collector/confmap"
	"go.opentelemetry.io/collector/confmap/provider/envprovider"
	"go.opentelemetry.io/collector/confmap/provider/fileprovider"
	"go.opentelemetry.io/collector/confmap/provider/yamlprovider"
	"go.opentelemetry.io/collector/featuregate"
	"go.opentelemetry.io/collector/otelcol"
)

const agentVersion = "0.1.0"

func main() {
	if err := execute(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "datacat-agent:", err)
		os.Exit(1)
	}
}

func execute(args []string) error {
	// Retain the upper trace-ID bits supplied by migration tracers.
	if err := featuregate.GlobalRegistry().Set("receiver.datadogreceiver.Enable128BitTraceID", true); err != nil {
		return fmt.Errorf("enable migration trace correlation: %w", err)
	}
	if len(args) == 0 || args[0] == "--help" || args[0] == "help" {
		fmt.Println("DataCat Agent " + agentVersion + "\n\nUsage:\n  datacat-agent run -c /etc/datacat/datacat.yaml\n  datacat-agent config -c FILE [--show-secrets]\n  datacat-agent collector --config FILE\n  datacat-agent version\n\nconfig redacts the API key unless --show-secrets is given.\ncollector accepts an unmodified OpenTelemetry Collector configuration.")
		return nil
	}
	if args[0] == "version" || args[0] == "--version" {
		fmt.Println("DataCat Agent " + agentVersion + " (OpenTelemetry Collector 0.165.0)")
		return nil
	}
	settings := otelcol.CollectorSettings{
		BuildInfo: component.BuildInfo{Command: "datacat-agent", Description: "DataCat host telemetry agent", Version: agentVersion},
		Factories: components,
		ConfigProviderSettings: otelcol.ConfigProviderSettings{ResolverSettings: confmap.ResolverSettings{
			ProviderFactories: []confmap.ProviderFactory{fileprovider.NewFactory(), envprovider.NewFactory(), yamlprovider.NewFactory()},
		}},
	}
	if args[0] == "collector" {
		cmd := otelcol.NewCommand(settings)
		cmd.SetArgs(args[1:])
		return cmd.Execute()
	}
	if args[0] != "run" && args[0] != "config" {
		return fmt.Errorf("unknown command %q (use --help)", args[0])
	}
	path := defaultConfigPath()
	showSecrets := false
	for i := 1; i < len(args); i++ {
		switch args[i] {
		case "-c", "--config":
			i++
			if i == len(args) {
				return fmt.Errorf("-c requires a file path")
			}
			path = args[i]
		case "--show-secrets":
			showSecrets = true
		default:
			return fmt.Errorf("unknown argument %q", args[i])
		}
	}
	cfg, err := loadConfig(path)
	if err != nil {
		return err
	}
	if args[0] == "config" && !showSecrets {
		cfg.APIKey = "REDACTED"
	}
	generated, err := generateConfig(cfg)
	if err != nil {
		return err
	}
	if args[0] == "config" {
		fmt.Print(string(generated))
		return nil
	}
	// The configuration lives only in memory: no temporary file containing credentials.
	settings.ConfigProviderSettings.ResolverSettings.URIs = []string{"yaml:" + string(generated)}
	return runInteractive(settings)
}

func runInteractive(settings otelcol.CollectorSettings) error {
	cmd := otelcol.NewCommand(settings)
	cmd.SetArgs([]string{})
	return cmd.Execute()
}

// defaultConfigPath is /etc/datacat/datacat.yaml.
func defaultConfigPath() string {
	return "/etc/datacat/datacat.yaml"
}
