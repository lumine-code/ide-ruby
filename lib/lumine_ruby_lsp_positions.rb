# frozen_string_literal: true

# Ruby LSP 0.26.x negotiates UTF-16, but its shared Prism range helpers still
# return byte columns. RubyIndexer::Location already stores negotiated columns;
# only Prism locations need conversion. Keep the correction inside the server so
# references and workspace edits for closed files use their actual source too.
module LumineRubyLspPositions
  def range_from_location(location)
    return super unless defined?(Prism::Location) && location.is_a?(Prism::Location)
    return super unless lumine_utf16_ranges?

    RubyLsp::Interface::Range.new(
      start: RubyLsp::Interface::Position.new(
        line: location.start_line - 1,
        character: location.start_code_units_column(Encoding::UTF_16LE)
      ),
      end: RubyLsp::Interface::Position.new(
        line: location.end_line - 1,
        character: location.end_code_units_column(Encoding::UTF_16LE)
      )
    )
  end

  def range_from_node(node)
    return super unless lumine_utf16_ranges?

    range_from_location(node.location)
  end

  private

  def lumine_utf16_ranges?
    return false unless defined?(RubyLsp::VERSION) &&
      Gem::Version.new(RubyLsp::VERSION) >= Gem::Version.new("0.26.0") &&
      Gem::Version.new(RubyLsp::VERSION) <= Gem::Version.new("0.26.11")

    encoding = if instance_variable_defined?(:@global_state)
      @global_state.encoding
    elsif instance_variable_defined?(:@document)
      @document.encoding
    elsif instance_variable_defined?(:@index)
      @index.configuration.encoding
    end
    encoding == Encoding::UTF_16LE
  end
end

module RubyLsp
  module Requests
    module Support
      module Common
        prepend LumineRubyLspPositions
      end
    end
  end
end
